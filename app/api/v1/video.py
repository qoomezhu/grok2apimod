"""
Videos API 路由（OpenAI compatible create endpoint）
"""

import base64
import json
import re
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.datastructures import UploadFile as StarletteUploadFile

from app.core.exceptions import UpstreamException, ValidationException
from app.services.grok.media import VideoService
from app.services.grok.model import ModelService


router = APIRouter(tags=["Videos"])

VIDEO_MODEL_ID = "grok-imagine-1.0-video"
SIZE_TO_ASPECT = {
    "1280x720": "16:9",
    "720x1280": "9:16",
    "1792x1024": "3:2",
    "1024x1792": "2:3",
    "1024x1024": "1:1",
}
QUALITY_TO_RESOLUTION = {
    "standard": "SD",
    "high": "HD",
}


class VideoCreateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    prompt: str = Field(..., description="Video prompt")
    model: Optional[str] = Field(VIDEO_MODEL_ID, description="Model id")
    size: Optional[str] = Field("1792x1024", description="Output size")
    seconds: Optional[int] = Field(6, description="Video length in seconds")
    quality: Optional[str] = Field("standard", description="Quality: standard/high")
    image_reference: Optional[Any] = Field(None, description="Structured image reference")


def _raise_validation_error(exc: ValidationError) -> None:
    errors = exc.errors()
    if errors:
        first = errors[0]
        loc = first.get("loc", [])
        msg = first.get("msg", "Invalid request")
        code = first.get("type", "invalid_value")
        param_parts = [str(x) for x in loc if not (isinstance(x, int) or str(x).isdigit())]
        param = ".".join(param_parts) if param_parts else None
        raise ValidationException(message=msg, param=param, code=code)
    raise ValidationException(message="Invalid request", code="invalid_value")


def _extract_video_url(content: str) -> str:
    if not isinstance(content, str) or not content.strip():
        return ""

    md_match = re.search(r"\[video\]\(([^)\s]+)\)", content)
    if md_match:
        return md_match.group(1).strip()

    html_match = re.search(r"""<source[^>]+src=["']([^"']+)["']""", content)
    if html_match:
        return html_match.group(1).strip()

    url_match = re.search(r"""https?://[^\s"'<>]+""", content)
    if url_match:
        return url_match.group(0).strip().rstrip(".,)")

    return ""


def _normalize_model(model: Optional[str]) -> str:
    requested = (model or VIDEO_MODEL_ID).strip()
    if requested != VIDEO_MODEL_ID:
        raise ValidationException(
            message=f"The model `{VIDEO_MODEL_ID}` is required for video generation.",
            param="model",
            code="model_not_supported",
        )
    model_info = ModelService.get(requested)
    if not model_info or not model_info.is_video:
        raise ValidationException(
            message=f"The model `{requested}` is not supported for video generation.",
            param="model",
            code="model_not_supported",
        )
    return requested


def _normalize_size(size: Optional[str]) -> Tuple[str, str]:
    value = (size or "1792x1024").strip()
    aspect_ratio = SIZE_TO_ASPECT.get(value)
    if not aspect_ratio:
        raise ValidationException(
            message=f"size must be one of {sorted(SIZE_TO_ASPECT.keys())}",
            param="size",
            code="invalid_size",
        )
    return value, aspect_ratio


def _normalize_quality(quality: Optional[str]) -> Tuple[str, str]:
    value = (quality or "standard").strip().lower()
    resolution = QUALITY_TO_RESOLUTION.get(value)
    if not resolution:
        raise ValidationException(
            message=f"quality must be one of {sorted(QUALITY_TO_RESOLUTION.keys())}",
            param="quality",
            code="invalid_quality",
        )
    return value, resolution


def _normalize_seconds(seconds: Optional[int]) -> int:
    value = int(seconds or 6)
    if value < 6 or value > 30:
        raise ValidationException(
            message="seconds must be between 6 and 30",
            param="seconds",
            code="invalid_seconds",
        )
    return value


def _validate_reference_value(value: str, param: str) -> str:
    candidate = (value or "").strip()
    if not candidate:
        return ""
    if candidate.startswith("http://") or candidate.startswith("https://"):
        return candidate
    if candidate.startswith("data:"):
        return candidate
    raise ValidationException(
        message=f"{param} must be a URL or data URI",
        param=param,
        code="invalid_reference",
    )


def _parse_image_reference(value: Any) -> Optional[str]:
    if value is None or value == "":
        return None

    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        if stripped[0] in {"{", "["}:
            try:
                return _parse_image_reference(json.loads(stripped))
            except json.JSONDecodeError:
                return _validate_reference_value(stripped, "image_reference")
        return _validate_reference_value(stripped, "image_reference")

    if not isinstance(value, dict):
        raise ValidationException(
            message="image_reference must be an object with exactly one of image_url or file_id",
            param="image_reference",
            code="invalid_reference",
        )

    image_url = value.get("image_url")
    file_id = value.get("file_id")
    image_url = image_url.strip() if isinstance(image_url, str) else ""
    file_id = file_id.strip() if isinstance(file_id, str) else ""

    has_image_url = bool(image_url)
    has_file_id = bool(file_id)
    if has_image_url == has_file_id:
        raise ValidationException(
            message="image_reference requires exactly one of image_url or file_id",
            param="image_reference",
            code="invalid_reference",
        )

    if has_file_id:
        raise ValidationException(
            message="image_reference.file_id is not supported; please use image_reference.image_url",
            param="image_reference.file_id",
            code="unsupported_reference",
        )

    return _validate_reference_value(image_url, "image_reference.image_url")


async def _upload_to_data_uri(file: UploadFile, param: str) -> str:
    payload = await file.read()
    if not payload:
        raise ValidationException(
            message=f"{param} upload is empty",
            param=param,
            code="empty_file",
        )
    content_type = (file.content_type or "application/octet-stream").strip()
    encoded = base64.b64encode(payload).decode()
    return f"data:{content_type};base64,{encoded}"


def _build_content(prompt: str, references: List[str]) -> List[Dict[str, Any]]:
    content: List[Dict[str, Any]] = [{"type": "text", "text": prompt}]
    for ref in references:
        content.append({"type": "image_url", "image_url": {"url": ref}})
    return content


def _build_create_response(
    *,
    model: str,
    prompt: str,
    size: str,
    seconds: int,
    quality: str,
    url: str,
) -> Dict[str, Any]:
    ts = int(time.time())
    return {
        "id": f"video_{uuid.uuid4().hex[:24]}",
        "object": "video",
        "created_at": ts,
        "completed_at": ts,
        "status": "completed",
        "model": model,
        "prompt": prompt,
        "size": size,
        "seconds": str(seconds),
        "quality": quality,
        "url": url,
    }


async def _create_video(payload: VideoCreateRequest, references: List[str]) -> JSONResponse:
    prompt = (payload.prompt or "").strip()
    if not prompt:
        raise ValidationException(
            message="prompt is required",
            param="prompt",
            code="invalid_request_error",
        )

    model = _normalize_model(payload.model)
    size, aspect_ratio = _normalize_size(payload.size)
    quality, resolution = _normalize_quality(payload.quality)
    seconds = _normalize_seconds(payload.seconds)

    result = await VideoService.completions(
        model=model,
        messages=[{"role": "user", "content": _build_content(prompt, references)}],
        stream=False,
        thinking=None,
        aspect_ratio=aspect_ratio,
        video_length=seconds,
        resolution=resolution,
        preset="custom",
    )

    choices = result.get("choices") if isinstance(result, dict) else None
    if not isinstance(choices, list) or not choices:
        raise UpstreamException("Video generation failed: empty result")

    msg = choices[0].get("message", {}) if isinstance(choices[0], dict) else {}
    rendered = msg.get("content", "") if isinstance(msg, dict) else ""
    video_url = _extract_video_url(rendered)
    if not video_url:
        raise UpstreamException("Video generation failed: missing video URL")

    return JSONResponse(
        content=_build_create_response(
            model=model,
            prompt=prompt,
            size=size,
            seconds=seconds,
            quality=quality,
            url=video_url,
        )
    )


@router.post("/videos")
async def create_video(request: Request):
    """OpenAI-compatible /v1/videos create endpoint."""
    content_type = (request.headers.get("content-type") or "").lower()
    if "application/json" in content_type:
        try:
            raw = await request.json()
        except ValueError:
            raise ValidationException(
                message="Invalid JSON in request body.",
                param="body",
                code="json_invalid",
            )
        if not isinstance(raw, dict):
            raise ValidationException(
                message="Request body must be a JSON object",
                param="body",
                code="invalid_request_error",
            )
        try:
            payload = VideoCreateRequest.model_validate(raw)
        except ValidationError as exc:
            _raise_validation_error(exc)
        references: List[str] = []
        parsed_image_reference = _parse_image_reference(payload.image_reference)
        if parsed_image_reference:
            references.append(parsed_image_reference)
        return await _create_video(payload, references)

    form = await request.form()
    try:
        payload = VideoCreateRequest.model_validate(
            {
                "prompt": form.get("prompt"),
                "model": form.get("model"),
                "size": form.get("size"),
                "seconds": form.get("seconds"),
                "quality": form.get("quality"),
                "image_reference": form.get("image_reference"),
            }
        )
    except ValidationError as exc:
        _raise_validation_error(exc)

    references: List[str] = []
    input_reference = form.get("input_reference")
    if isinstance(input_reference, (UploadFile, StarletteUploadFile)):
        references.append(await _upload_to_data_uri(input_reference, "input_reference"))
    elif input_reference not in (None, ""):
        raise ValidationException(
            message="input_reference must be a file in multipart/form-data",
            param="input_reference",
            code="invalid_reference",
        )

    parsed_image_reference = _parse_image_reference(payload.image_reference)
    if parsed_image_reference:
        references.append(parsed_image_reference)
    return await _create_video(payload, references)


__all__ = ["router"]
