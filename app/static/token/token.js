let apiKey = '';
let tokenRows = [];
let stats = {};
let currentFilter = 'all';
let currentPage = 1;
let pageSize = 50;
let currentJobId = null;
let currentJobKind = '';
let jobPollTimer = null;

const FILTERS = ['all', 'active', 'cooling', 'exhausted', 'invalid', 'disabled', 'nsfw', 'no-nsfw'];
const PAGE_SIZES = [20, 50, 100, 200];

function normalizeSsoToken(token) {
  const value = String(token || '').trim();
  return value.startsWith('sso=') ? value.slice(4).trim() : value;
}

function extractApiErrorMessage(payload, fallback = '请求失败') {
  if (!payload) return fallback;
  if (typeof payload === 'string') return payload;
  return payload.error || payload.message || payload.detail || fallback;
}

async function parseJsonSafely(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getSelectedRows() {
  return tokenRows.filter((row) => row._selected);
}

function getFilteredRows() {
  switch (currentFilter) {
    case 'active': return tokenRows.filter((row) => row.status === 'active');
    case 'cooling': return tokenRows.filter((row) => row.status === 'cooling');
    case 'exhausted': return tokenRows.filter((row) => row.status === 'exhausted');
    case 'invalid': return tokenRows.filter((row) => row.status === 'invalid');
    case 'disabled': return tokenRows.filter((row) => row.status === 'disabled');
    case 'nsfw': return tokenRows.filter((row) => row.nsfw_enabled);
    case 'no-nsfw': return tokenRows.filter((row) => !row.nsfw_enabled);
    default: return tokenRows;
  }
}

function getPaginationData() {
  const filtered = getFilteredRows();
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  if (currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * pageSize;
  return {
    filtered,
    totalPages,
    visible: filtered.slice(start, start + pageSize),
  };
}

function updateCounters() {
  document.getElementById('stat-total').innerText = (stats.total || 0).toLocaleString();
  document.getElementById('stat-active').innerText = (stats.active || 0).toLocaleString();
  document.getElementById('stat-cooling').innerText = ((stats.cooling || 0) + (stats.exhausted || 0)).toLocaleString();
  document.getElementById('stat-invalid').innerText = ((stats.invalid || 0) + (stats.disabled || 0)).toLocaleString();
  document.getElementById('stat-chat-quota').innerText = (stats.chat_quota || 0).toLocaleString();
  document.getElementById('stat-image-quota').innerText = (stats.image_quota || 0).toLocaleString();
  document.getElementById('stat-total-calls').innerText = (stats.total_calls || 0).toLocaleString();
  document.getElementById('stat-nsfw').innerText = (stats.nsfw || 0).toLocaleString();

  const countMap = {
    all: stats.total || 0,
    active: stats.active || 0,
    cooling: stats.cooling || 0,
    exhausted: stats.exhausted || 0,
    invalid: stats.invalid || 0,
    disabled: stats.disabled || 0,
    nsfw: stats.nsfw || 0,
    'no-nsfw': stats.no_nsfw || 0,
  };
  FILTERS.forEach((key) => {
    const el = document.getElementById(`tab-count-${key}`);
    if (el) el.innerText = countMap[key] || 0;
  });
}

function renderTabs() {
  FILTERS.forEach((key) => {
    const btn = document.querySelector(`button[data-filter="${key}"]`);
    if (!btn) return;
    btn.classList.toggle('active', key === currentFilter);
  });
}

function renderPagination() {
  const { filtered, totalPages } = getPaginationData();
  const info = document.getElementById('pagination-info');
  if (info) info.innerText = filtered.length ? `第 ${currentPage}/${totalPages} 页，共 ${filtered.length} 条` : '无数据';
  document.getElementById('page-prev').disabled = currentPage <= 1;
  document.getElementById('page-next').disabled = currentPage >= totalPages;
  const size = document.getElementById('page-size');
  if (size && String(size.value) !== String(pageSize)) size.value = String(pageSize);
}

function renderSelectionState() {
  const selectedCount = getSelectedRows().length;
  document.getElementById('selected-count').innerText = selectedCount;
  const { visible } = getPaginationData();
  const allVisibleSelected = visible.length > 0 && visible.every((row) => row._selected);
  const selectAll = document.getElementById('select-all');
  if (selectAll) {
    selectAll.checked = allVisibleSelected;
    selectAll.indeterminate = !allVisibleSelected && visible.some((row) => row._selected);
  }

  ['btn-batch-export', 'btn-batch-refresh', 'btn-batch-disable', 'btn-batch-enable', 'btn-batch-nsfw', 'btn-batch-delete']
    .forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = selectedCount === 0 || Boolean(currentJobId);
    });
}

function renderTable() {
  const tbody = document.getElementById('token-table-body');
  const empty = document.getElementById('empty-state');
  const { visible } = getPaginationData();
  tbody.innerHTML = '';

  if (!visible.length) {
    empty.classList.remove('hidden');
    empty.innerText = currentFilter === 'all' ? '暂无 Token，请点击右上角添加或导入。' : '当前筛选条件下没有数据。';
    renderSelectionState();
    renderPagination();
    return;
  }

  empty.classList.add('hidden');
  visible.forEach((row) => {
    const tokenShort = row.token.length > 26 ? `${row.token.slice(0, 8)}...${row.token.slice(-12)}` : row.token;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="text-center"><input type="checkbox" class="checkbox" ${row._selected ? 'checked' : ''}></td>
      <td class="text-left">
        <div class="flex items-center gap-2">
          <span class="font-mono text-xs text-gray-500" title="${escapeHtml(row.token)}">${escapeHtml(tokenShort)}</span>
          <button class="text-gray-400 hover:text-black" data-copy="1">复制</button>
        </div>
      </td>
      <td class="text-center"><span class="badge badge-gray">${escapeHtml(row.pool)}</span></td>
      <td class="text-center">${renderStatusBadge(row)}</td>
      <td class="text-left">${renderTagBadges(row)}</td>
      <td class="text-center font-mono text-xs">${row.quota_known ? row.quota : '-'}</td>
      <td class="text-left text-gray-500 text-xs truncate max-w-[160px]">${escapeHtml(row.note || '-')}</td>
      <td class="text-center">
        <div class="flex items-center justify-center gap-2 flex-wrap">
          <button class="text-xs text-gray-500 hover:text-black" data-act="refresh">刷新</button>
          <button class="text-xs text-gray-500 hover:text-black" data-act="nsfw">${row.nsfw_enabled ? '重试NSFW' : '开NSFW'}</button>
          <button class="text-xs text-gray-500 hover:text-black" data-act="toggle">${row.status === 'disabled' ? '启用' : '禁用'}</button>
          <button class="text-xs text-gray-500 hover:text-black" data-act="edit">编辑</button>
          <button class="text-xs text-red-500 hover:text-red-700" data-act="delete">删除</button>
        </div>
      </td>`;

    tr.querySelector('input[type="checkbox"]').addEventListener('change', () => {
      row._selected = !row._selected;
      renderSelectionState();
    });
    tr.querySelector('[data-copy="1"]').addEventListener('click', () => navigator.clipboard.writeText(row.token));
    tr.querySelector('[data-act="refresh"]').addEventListener('click', () => refreshSingleToken(row.token));
    tr.querySelector('[data-act="nsfw"]').addEventListener('click', () => enableSingleTokenNsfw(row.token));
    tr.querySelector('[data-act="toggle"]').addEventListener('click', () => toggleSingleTokenStatus(row));
    tr.querySelector('[data-act="edit"]').addEventListener('click', () => openEditModal(row.token));
    tr.querySelector('[data-act="delete"]').addEventListener('click', () => deleteSingleToken(row.token));
    tbody.appendChild(tr);
  });

  renderSelectionState();
  renderPagination();
}

function renderStatusBadge(row) {
  const map = {
    active: 'badge-green',
    cooling: 'badge-orange',
    exhausted: 'badge-orange',
    invalid: 'badge-red',
    disabled: 'badge-gray',
  };
  const textMap = {
    active: '活跃',
    cooling: '冷却',
    exhausted: '耗尽',
    invalid: '失效',
    disabled: '禁用',
  };
  return `<span class="badge ${map[row.status] || 'badge-gray'}">${textMap[row.status] || row.status}</span>`;
}

function renderTagBadges(row) {
  const tags = Array.isArray(row.tags) ? row.tags : [];
  const pills = [];
  pills.push(`<span class="badge ${row.nsfw_enabled ? 'badge-green' : 'badge-gray'}">${row.nsfw_enabled ? 'NSFW' : '未开启'}</span>`);
  tags.filter((tag) => tag !== 'nsfw').forEach((tag) => pills.push(`<span class="badge badge-gray">${escapeHtml(tag)}</span>`));
  return `<div class="flex flex-wrap items-center gap-1">${pills.join('')}</div>`;
}

async function loadData() {
  try {
    const res = await fetch('/api/v1/admin/tokens/table', { headers: buildAuthHeaders(apiKey) });
    if (res.status === 401) return logout();
    const payload = await parseJsonSafely(res);
    if (!res.ok || !payload?.success) throw new Error(extractApiErrorMessage(payload, '加载失败'));
    const prevSelected = new Set(getSelectedRows().map((row) => row.token));
    tokenRows = (payload.data || []).map((row) => ({ ...row, _selected: prevSelected.has(row.token) }));
    stats = payload.stats || {};
    updateCounters();
    renderTabs();
    renderTable();
  } catch (e) {
    showToast(e.message || '加载失败', 'error');
  }
}

async function syncAllTokens() {
  const payload = { ssoBasic: [], ssoSuper: [] };
  tokenRows.forEach((row) => {
    payload[row.pool].push({
      token: row.token,
      status: row.raw_status || row.status,
      quota: row.quota_known ? row.quota : -1,
      heavy_quota: row.heavy_quota_known ? row.heavy_quota : -1,
      note: row.note || '',
      tags: row.tags || [],
    });
  });

  const res = await fetch('/api/v1/admin/tokens/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(apiKey) },
    body: JSON.stringify(payload),
  });
  const json = await parseJsonSafely(res);
  if (!res.ok || !json?.success) throw new Error(extractApiErrorMessage(json, '同步 Token 失败'));
}

function setFilter(filter) {
  currentFilter = filter;
  currentPage = 1;
  renderTabs();
  renderTable();
}

function toggleSelectAll() {
  const checked = document.getElementById('select-all').checked;
  getPaginationData().visible.forEach((row) => { row._selected = checked; });
  renderTable();
}

function selectVisible() {
  getPaginationData().visible.forEach((row) => { row._selected = true; });
  renderSelectionState();
  renderTable();
}

function selectFiltered() {
  getFilteredRows().forEach((row) => { row._selected = true; });
  renderSelectionState();
  renderTable();
}

function clearSelection() {
  tokenRows.forEach((row) => { row._selected = false; });
  renderSelectionState();
  renderTable();
}

async function batchDelete() {
  const selected = getSelectedRows();
  if (!selected.length) return;
  const ok = await confirmAction(`确定删除选中的 ${selected.length} 个 Token 吗？`, '删除');
  if (!ok) return;
  const selectedSet = new Set(selected.map((row) => row.token));
  tokenRows = tokenRows.filter((row) => !selectedSet.has(row.token));
  await syncAllTokens();
  await loadData();
}

function batchExport() {
  const selected = getSelectedRows();
  if (!selected.length) return showToast('请先选择 Token', 'error');
  const blob = new Blob([selected.map((row) => row.token).join('\n') + '\n'], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tokens_selected_${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

async function setSelectedStatus(status) {
  const selected = getSelectedRows();
  if (!selected.length) return showToast('请先选择 Token', 'error');
  const actionText = status === 'disabled' ? '禁用' : '启用';
  const ok = await confirmAction(`确定${actionText}选中的 ${selected.length} 个 Token 吗？`, actionText);
  if (!ok) return;
  const res = await fetch('/api/v1/admin/tokens/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(apiKey) },
    body: JSON.stringify({ tokens: selected.map((row) => row.token), status }),
  });
  const json = await parseJsonSafely(res);
  if (!res.ok || !json?.success) return showToast(extractApiErrorMessage(json, `${actionText}失败`), 'error');
  showToast(`${actionText}完成`, 'success');
  await loadData();
}

async function toggleSingleTokenStatus(row) {
  const nextStatus = row.status === 'disabled' ? 'active' : 'disabled';
  const actionText = nextStatus === 'disabled' ? '禁用' : '启用';
  const ok = await confirmAction(`确定${actionText}该 Token 吗？`, actionText);
  if (!ok) return;
  const res = await fetch('/api/v1/admin/tokens/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(apiKey) },
    body: JSON.stringify({ token: row.token, status: nextStatus }),
  });
  const json = await parseJsonSafely(res);
  if (!res.ok || !json?.success) return showToast(extractApiErrorMessage(json, `${actionText}失败`), 'error');
  await loadData();
}

async function refreshSingleToken(token) {
  const res = await fetch('/api/v1/admin/tokens/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(apiKey) },
    body: JSON.stringify({ token }),
  });
  const json = await parseJsonSafely(res);
  if (!res.ok || json?.status !== 'success') return showToast(extractApiErrorMessage(json, '刷新失败'), 'error');
  const success = Boolean(json.results?.[token] || json.results?.[`sso=${token}`]);
  showToast(success ? '刷新成功' : '刷新失败', success ? 'success' : 'error');
  await loadData();
}

async function enableSingleTokenNsfw(token) {
  const ok = await confirmAction('将执行：同意协议 + 设置年龄 + 开启 NSFW，是否继续？', '开启');
  if (!ok) return;
  const res = await fetch('/api/v1/admin/tokens/nsfw/enable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(apiKey) },
    body: JSON.stringify({ tokens: [token] }),
  });
  const json = await parseJsonSafely(res);
  if (!res.ok || json?.status !== 'success') return showToast(extractApiErrorMessage(json, 'NSFW 刷新失败'), 'error');
  const summary = json.summary || {};
  showToast(`NSFW 完成：成功 ${summary.success || summary.ok || 0}，失败 ${summary.failed || summary.fail || 0}`, 'success');
  await loadData();
}

async function startAsyncJob(kind, endpoint, body) {
  if (currentJobId) return showToast('已有任务在执行中', 'info');
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(apiKey) },
    body: JSON.stringify(body),
  });
  const json = await parseJsonSafely(res);
  if (!res.ok || json?.status !== 'success') return showToast(extractApiErrorMessage(json, '启动任务失败'), 'error');
  currentJobId = json.task_id;
  currentJobKind = kind;
  renderJobProgress({ processed: 0, total: json.total || 0, status: 'queued', success: 0, failed: 0 });
  pollJob();
}

function renderJobProgress(job) {
  const wrap = document.getElementById('batch-progress');
  const text = document.getElementById('batch-progress-text');
  if (!currentJobId || !job) {
    wrap.classList.add('hidden');
    return;
  }
  const total = Number(job.total || 0);
  const processed = Number(job.processed || 0);
  const percent = total ? Math.floor((processed / total) * 100) : 0;
  text.innerText = `${currentJobKind === 'nsfw' ? 'NSFW' : '刷新'} ${processed}/${total} (${percent}%)`;
  wrap.classList.remove('hidden');
  renderSelectionState();
}

async function pollJob() {
  clearTimeout(jobPollTimer);
  if (!currentJobId) return;
  const res = await fetch(`/api/v1/admin/jobs/${currentJobId}`, { headers: buildAuthHeaders(apiKey) });
  const json = await parseJsonSafely(res);
  if (!res.ok || !json?.success) {
    showToast(extractApiErrorMessage(json, '读取任务失败'), 'error');
    finishJobPolling();
    return;
  }
  const job = json.data;
  renderJobProgress(job);
  if (job.status === 'completed') {
    const summary = job.result?.summary || {};
    showToast(`${currentJobKind === 'nsfw' ? 'NSFW' : '刷新'}完成：成功 ${summary.success || 0}，失败 ${summary.failed || 0}`, (summary.failed || 0) > 0 ? 'info' : 'success');
    finishJobPolling();
    await loadData();
    return;
  }
  if (job.status === 'failed') {
    showToast(job.error || '任务失败', 'error');
    finishJobPolling();
    await loadData();
    return;
  }
  if (job.status === 'cancelled') {
    showToast('任务已取消', 'info');
    finishJobPolling();
    await loadData();
    return;
  }
  jobPollTimer = setTimeout(pollJob, 1200);
}

function finishJobPolling() {
  currentJobId = null;
  currentJobKind = '';
  clearTimeout(jobPollTimer);
  renderJobProgress(null);
  renderSelectionState();
}

async function cancelCurrentJob() {
  if (!currentJobId) return;
  await fetch(`/api/v1/admin/jobs/${currentJobId}/cancel`, { method: 'POST', headers: buildAuthHeaders(apiKey) });
  showToast('已请求取消任务', 'info');
}

function batchRefresh() {
  const selected = getSelectedRows();
  if (!selected.length) return showToast('请先选择 Token', 'error');
  startAsyncJob('refresh', '/api/v1/admin/tokens/refresh/async', { tokens: selected.map((row) => row.token) });
}

async function batchNsfw() {
  const selected = getSelectedRows();
  if (!selected.length) return showToast('请先选择 Token', 'error');
  const ok = await confirmAction(`将为选中的 ${selected.length} 个 Token 分批执行 NSFW 开启，是否继续？`, '开始');
  if (!ok) return;
  startAsyncJob('nsfw', '/api/v1/admin/tokens/nsfw/enable/async', { tokens: selected.map((row) => row.token) });
}

async function startAllNsfw() {
  const ok = await confirmAction(`将为当前 Token 池的 ${tokenRows.length} 个 Token 执行 Workers 友好的 NSFW 批处理，是否继续？`, '开始');
  if (!ok) return;
  startAsyncJob('nsfw', '/api/v1/admin/tokens/nsfw/enable/async', { all: true });
}

function changePageSize() {
  pageSize = Number(document.getElementById('page-size').value) || 50;
  currentPage = 1;
  renderTable();
}

function goPrevPage() {
  if (currentPage > 1) currentPage -= 1;
  renderTable();
}

function goNextPage() {
  const { totalPages } = getPaginationData();
  if (currentPage < totalPages) currentPage += 1;
  renderTable();
}

function openImportModal() {
  document.getElementById('import-modal').classList.remove('hidden');
}

function closeImportModal() {
  document.getElementById('import-modal').classList.add('hidden');
  document.getElementById('import-text').value = '';
}

async function submitImport() {
  const pool = document.getElementById('import-pool').value || 'ssoBasic';
  const tokens = document.getElementById('import-text').value.split('\n').map((line) => normalizeSsoToken(line)).filter(Boolean);
  const exists = new Set(tokenRows.map((row) => row.token));
  tokens.forEach((token) => {
    if (exists.has(token)) return;
    tokenRows.push({
      token,
      pool,
      token_type: pool === 'ssoSuper' ? 'ssoSuper' : 'sso',
      status: 'active',
      raw_status: 'active',
      quota: pool === 'ssoSuper' ? 140 : 80,
      quota_known: true,
      heavy_quota: pool === 'ssoSuper' ? 140 : -1,
      heavy_quota_known: pool === 'ssoSuper',
      note: '',
      tags: [],
      nsfw_enabled: false,
      fail_count: 0,
      use_count: 0,
      _selected: false,
    });
  });
  await syncAllTokens();
  closeImportModal();
  await loadData();
}

function openAddModal() {
  document.getElementById('edit-modal-title').innerText = '添加 Token';
  document.getElementById('edit-token-original').value = '';
  document.getElementById('edit-token').value = '';
  document.getElementById('edit-pool').value = 'ssoBasic';
  document.getElementById('edit-quota').value = 80;
  document.getElementById('edit-note').value = '';
  document.getElementById('edit-modal').classList.remove('hidden');
}

function openEditModal(token) {
  const row = tokenRows.find((item) => item.token === token);
  if (!row) return;
  document.getElementById('edit-modal-title').innerText = '编辑 Token';
  document.getElementById('edit-token-original').value = row.token;
  document.getElementById('edit-token').value = row.token;
  document.getElementById('edit-pool').value = row.pool;
  document.getElementById('edit-quota').value = row.quota_known ? row.quota : '';
  document.getElementById('edit-note').value = row.note || '';
  document.getElementById('edit-modal').classList.remove('hidden');
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.add('hidden');
}

async function saveEdit() {
  const original = normalizeSsoToken(document.getElementById('edit-token-original').value);
  const token = normalizeSsoToken(document.getElementById('edit-token').value);
  const pool = document.getElementById('edit-pool').value || 'ssoBasic';
  const quota = Number(document.getElementById('edit-quota').value || (pool === 'ssoSuper' ? 140 : 80));
  const note = document.getElementById('edit-note').value.trim();
  if (!token) return showToast('Token 不能为空', 'error');
  const duplicate = tokenRows.find((row) => row.token === token && row.token !== original);
  if (duplicate) return showToast('Token 已存在', 'error');

  if (original) {
    const row = tokenRows.find((item) => item.token === original);
    if (!row) return;
    row.token = token;
    row.pool = pool;
    row.token_type = pool === 'ssoSuper' ? 'ssoSuper' : 'sso';
    row.quota = quota;
    row.quota_known = true;
    row.heavy_quota = row.token_type === 'ssoSuper' ? Math.max(row.heavy_quota, quota) : -1;
    row.heavy_quota_known = row.token_type === 'ssoSuper';
    row.note = note;
  } else {
    tokenRows.unshift({
      token,
      pool,
      token_type: pool === 'ssoSuper' ? 'ssoSuper' : 'sso',
      status: 'active',
      raw_status: 'active',
      quota,
      quota_known: true,
      heavy_quota: pool === 'ssoSuper' ? quota : -1,
      heavy_quota_known: pool === 'ssoSuper',
      note,
      tags: [],
      nsfw_enabled: false,
      fail_count: 0,
      use_count: 0,
      _selected: false,
    });
  }

  await syncAllTokens();
  closeEditModal();
  await loadData();
}

async function deleteSingleToken(token) {
  const ok = await confirmAction('确定删除该 Token 吗？', '删除');
  if (!ok) return;
  tokenRows = tokenRows.filter((row) => row.token !== token);
  await syncAllTokens();
  await loadData();
}

function addToken() {
  openAddModal();
}

let confirmResolver = null;
function confirmAction(message, okText = '确定') {
  document.getElementById('confirm-message').innerText = message;
  document.getElementById('confirm-ok').innerText = okText;
  document.getElementById('confirm-dialog').classList.remove('hidden');
  return new Promise((resolve) => { confirmResolver = resolve; });
}

function closeConfirm(ok) {
  document.getElementById('confirm-dialog').classList.add('hidden');
  if (confirmResolver) confirmResolver(ok);
  confirmResolver = null;
}

async function init() {
  apiKey = await ensureApiKey();
  if (apiKey === null) return;
  const pageSizeSelect = document.getElementById('page-size');
  pageSizeSelect.innerHTML = PAGE_SIZES.map((size) => `<option value="${size}">${size}/页</option>`).join('');
  pageSizeSelect.value = String(pageSize);
  await loadData();
}

window.onload = init;
