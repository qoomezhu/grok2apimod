let apiKey = '';
let currentConfig = {};
const NUMERIC_FIELDS = new Set([
  'timeout',
  'max_retry',
  'refresh_interval_hours',
  'fail_threshold',
  'nsfw_refresh_concurrency',
  'nsfw_refresh_retries',
  'limit_mb',
  'save_delay_ms',
  'assets_max_concurrent',
  'media_max_concurrent',
  'usage_max_concurrent',
  'assets_delete_batch_size',
  'admin_assets_batch_size',
  'reload_interval_sec',
  'solver_threads',
  'register_threads',
  'default_count'
]);

const CONFIG_ENDPOINT = '/api/v1/admin/config-extended';

const LOCALE_MAP = {
  app: {
    label: '应用设置',
    api_key: { title: 'API 密钥', desc: '调用 Grok2API 服务所需的 Bearer Token，请妥善保管。' },
    admin_username: { title: '后台账号', desc: '登录管理后台的用户名，默认 admin。' },
    app_key: { title: '后台密码', desc: '登录管理后台的密码，请妥善保管。' },
    app_url: { title: '应用地址', desc: '当前服务的外部访问 URL，用于文件链接访问。' },
    image_format: { title: '图片格式', desc: '生成的图片格式（url / base64 / b64_json）。' },
    video_format: { title: '视频格式', desc: '生成的视频格式（仅支持 url）。' }
  },
  grok: {
    label: 'Grok 设置',
    temporary: { title: '临时对话', desc: '是否启用临时对话模式。' },
    stream: { title: '流式响应', desc: '是否默认启用流式输出。' },
    thinking: { title: '思维链', desc: '是否启用模型思维链输出。' },
    dynamic_statsig: { title: '动态指纹', desc: '是否启用动态生成 Statsig 值。' },
    filter_tags: { title: '过滤标签', desc: '自动过滤 Grok 响应中的特殊标签。' },
    video_poster_preview: { title: '视频海报预览', desc: '启用后会把返回中的 <video> 标签替换为封面预览图。' },
    timeout: { title: '超时时间', desc: '请求 Grok 服务的总超时时间（秒）。' },
    base_proxy_url: { title: '基础代理 URL', desc: '代理请求到 Grok 官网的基础服务地址。' },
    asset_proxy_url: { title: '资源代理 URL', desc: '代理请求到图片/视频等静态资源的地址。' },
    cf_clearance: { title: 'CF Clearance', desc: 'Cloudflare 验证 Cookie，保存时会自动净化复制粘贴中的脏字符。' },
    max_retry: { title: '最大重试', desc: '请求 Grok 服务失败时的最大重试次数。' },
    retry_status_codes: { title: '重试状态码', desc: '触发重试的 HTTP 状态码列表。' },
    image_generation_method: { title: '生图调用方式', desc: '旧方法稳定；新方法为实验性方法。' }
  },
  token: {
    label: 'Token 池设置',
    auto_refresh: { title: '自动刷新', desc: '是否开启 Token 自动刷新机制。' },
    refresh_interval_hours: { title: '刷新间隔', desc: 'Token 刷新的时间间隔（小时）。' },
    fail_threshold: { title: '失败阈值', desc: '单个 Token 连续失败多少次后标记为不可用。' },
    nsfw_refresh_concurrency: { title: 'NSFW 刷新并发', desc: 'Workers 端 NSFW 批处理的默认并发数，建议 1~3。' },
    nsfw_refresh_retries: { title: 'NSFW 刷新重试', desc: 'NSFW 刷新失败后的额外重试次数（不含首次）。' },
    save_delay_ms: { title: '保存延迟', desc: 'Token 变更合并写入的延迟（毫秒）。' },
    reload_interval_sec: { title: '一致性刷新', desc: '多 worker 场景下 Token 状态刷新间隔（秒）。' }
  },
  cache: {
    label: '缓存设置',
    enable_auto_clean: { title: '自动清理', desc: '是否启用缓存自动清理。' },
    limit_mb: { title: '清理阈值', desc: '缓存大小阈值（MB），超过阈值会触发清理。' },
    keep_base64_cache: { title: '保留 Base64 缓存', desc: '是否保留 base64 结果缓存。' }
  },
  performance: {
    label: '并发性能',
    assets_max_concurrent: { title: '资产并发上限', desc: '资源上传/下载/列表的并发上限。' },
    media_max_concurrent: { title: '媒体并发上限', desc: '视频/媒体生成请求的并发上限。' },
    usage_max_concurrent: { title: '用量并发上限', desc: '用量查询请求的并发上限。' },
    assets_delete_batch_size: { title: '资产清理批量', desc: '在线资产删除单批并发数量。' },
    admin_assets_batch_size: { title: '管理端批量', desc: '管理端在线资产统计/清理批量并发数量。' }
  },
  video: {
    label: '视频设置',
    upscale_timing: { title: '超分时机', desc: '与上游对齐：single 为单次扩展后超分，complete 为全部扩展完成后超分。Workers 端当前主要用于配置同步与后续兼容。' }
  },
  register: {
    label: '自动注册',
    worker_domain: { title: 'Worker 域名', desc: '临时邮箱 Worker 的域名（不含 https://）。' },
    email_domain: { title: '邮箱域名', desc: '临时邮箱使用的域名。' },
    admin_password: { title: '邮箱管理密码', desc: 'Worker 后台的管理密钥。' },
    yescaptcha_key: { title: 'YesCaptcha Key', desc: '可选。填写后优先使用 YesCaptcha。' },
    solver_url: { title: 'Solver 地址', desc: '本地 Turnstile Solver 地址。' },
    solver_browser_type: { title: 'Solver 浏览器', desc: '建议使用 camoufox，对 accounts.x.ai 成功率更高。' },
    solver_threads: { title: 'Solver 线程数', desc: '自动启动 Solver 时的线程数。' },
    register_threads: { title: '注册线程数', desc: '注册并发线程数。' },
    default_count: { title: '默认注册数量', desc: '未填写数量时默认注册多少个。' },
    auto_start_solver: { title: '自动启动 Solver', desc: '注册时自动启动本地 Solver。' },
    solver_debug: { title: 'Solver 调试', desc: '启动 Solver 时开启调试日志。' },
    max_errors: { title: '最大错误数', desc: '失败次数超过阈值会自动停止注册。0 表示自动计算。' },
    max_runtime_minutes: { title: '最长运行时间(分钟)', desc: '超过指定分钟数后自动停止注册。0 表示不限制。' }
  }
};

function getText(section, key) {
  if (LOCALE_MAP[section] && LOCALE_MAP[section][key]) return LOCALE_MAP[section][key];
  return { title: key.replace(/_/g, ' '), desc: '暂无说明，请参考配置文档。' };
}

function getSectionLabel(section) {
  return (LOCALE_MAP[section] && LOCALE_MAP[section].label) || `${section} 设置`;
}

async function init() {
  apiKey = await ensureApiKey();
  if (apiKey === null) return;
  loadData();
}

async function loadData() {
  try {
    const res = await fetch(CONFIG_ENDPOINT, { headers: buildAuthHeaders(apiKey) });
    if (res.ok) {
      currentConfig = await res.json();
      renderConfig(currentConfig);
    } else if (res.status === 401) {
      logout();
    } else {
      showToast('加载配置失败', 'error');
    }
  } catch (e) {
    showToast('连接失败', 'error');
  }
}

function renderConfig(data) {
  const container = document.getElementById('config-container');
  container.innerHTML = '';

  const sections = Object.keys(data || {});
  const sectionOrder = Object.keys(LOCALE_MAP);
  sections.sort((a, b) => {
    const ia = sectionOrder.indexOf(a);
    const ib = sectionOrder.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return 0;
  });

  sections.forEach(section => {
    const items = data[section];
    const card = document.createElement('div');
    card.className = 'config-section';
    card.innerHTML = `<div class="config-section-title">${getSectionLabel(section)}</div>`;

    const grid = document.createElement('div');
    grid.className = 'config-grid';

    const keys = Object.keys(items || {});
    if (LOCALE_MAP[section]) {
      const order = Object.keys(LOCALE_MAP[section]);
      keys.sort((a, b) => {
        const ia = order.indexOf(a);
        const ib = order.indexOf(b);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return 0;
      });
    }

    keys.forEach(key => {
      const value = items[key];
      const text = getText(section, key);
      const field = document.createElement('div');
      field.className = 'config-field';
      field.innerHTML = `<div class="config-field-title">${text.title}</div><p class="config-field-desc">${text.desc}</p>`;

      const inputWrapper = document.createElement('div');
      inputWrapper.className = 'config-field-input';
      let input;

      if (typeof value === 'boolean') {
        const label = document.createElement('label');
        label.className = 'relative inline-flex items-center cursor-pointer';
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = value;
        input.className = 'sr-only peer';
        input.dataset.section = section;
        input.dataset.key = key;
        const slider = document.createElement('div');
        slider.className = "w-9 h-5 bg-[var(--accents-2)] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-black";
        label.appendChild(input);
        label.appendChild(slider);
        inputWrapper.appendChild(label);
      } else if (key === 'image_format') {
        input = buildSelect(section, key, value, [
          { val: 'url', text: 'URL' },
          { val: 'base64', text: 'Base64' },
          { val: 'b64_json', text: 'b64_json' }
        ]);
        inputWrapper.appendChild(input);
      } else if (key === 'image_generation_method') {
        input = buildSelect(section, key, value, [
          { val: 'legacy', text: '旧方法（默认）' },
          { val: 'imagine_ws_experimental', text: '新方法（实验性）' }
        ]);
        inputWrapper.appendChild(input);
      } else if (key === 'video_format') {
        input = buildSelect(section, key, 'url', [{ val: 'url', text: 'URL' }]);
        inputWrapper.appendChild(input);
      } else if (key === 'upscale_timing') {
        input = buildSelect(section, key, value, [
          { val: 'complete', text: 'complete（默认）' },
          { val: 'single', text: 'single' }
        ]);
        inputWrapper.appendChild(input);
      } else if (Array.isArray(value) || (value && typeof value === 'object')) {
        input = document.createElement('textarea');
        input.className = 'geist-input font-mono text-xs';
        input.rows = 4;
        input.value = JSON.stringify(value, null, 2);
        input.dataset.section = section;
        input.dataset.key = key;
        input.dataset.type = 'json';
        inputWrapper.appendChild(input);
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.className = 'geist-input';
        input.value = value ?? '';
        input.dataset.section = section;
        input.dataset.key = key;
        inputWrapper.appendChild(input);
      }

      field.appendChild(inputWrapper);
      grid.appendChild(field);
    });

    card.appendChild(grid);
    if (grid.children.length > 0) container.appendChild(card);
  });
}

function buildSelect(section, key, currentValue, options) {
  const select = document.createElement('select');
  select.className = 'geist-input h-[34px]';
  select.dataset.section = section;
  select.dataset.key = key;
  options.forEach(opt => {
    const option = document.createElement('option');
    option.value = opt.val;
    option.text = opt.text;
    option.selected = String(currentValue) === String(opt.val);
    select.appendChild(option);
  });
  return select;
}

async function saveConfig() {
  const btn = document.getElementById('save-btn');
  const originalText = btn.innerText;
  btn.disabled = true;
  btn.innerText = '保存中...';

  try {
    const nextConfig = JSON.parse(JSON.stringify(currentConfig));
    const inputs = document.querySelectorAll('input[data-section], textarea[data-section], select[data-section]');

    inputs.forEach(input => {
      const section = input.dataset.section;
      const key = input.dataset.key;
      let value = input.value;
      if (input.type === 'checkbox') {
        value = input.checked;
      } else if (input.dataset.type === 'json') {
        value = JSON.parse(value || 'null');
      } else if (NUMERIC_FIELDS.has(key) && value.trim() !== '' && !Number.isNaN(Number(value))) {
        value = Number(value);
      }
      if (!nextConfig[section]) nextConfig[section] = {};
      nextConfig[section][key] = value;
    });

    const res = await fetch(CONFIG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(apiKey) },
      body: JSON.stringify(nextConfig)
    });

    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      throw new Error((payload && (payload.error || payload.message)) || '保存失败');
    }

    showToast('配置已保存', 'success');
    btn.innerText = '成功';
    setTimeout(() => { btn.innerText = originalText; }, 1200);
    await loadData();
  } catch (e) {
    showToast(`错误: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    if (btn.innerText === '保存中...') btn.innerText = originalText;
  }
}

window.onload = init;
