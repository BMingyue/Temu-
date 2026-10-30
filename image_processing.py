"""Explicit upload image policies; source images are never modified."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps


MIN_IMAGE_DIMENSION = 200
MAX_IMAGE_DIMENSION = 4000


@dataclass(frozen=True)
class ImageProcessingOptions:
    # ``square`` is retained as the policy name for old 1200×1200 behavior,
    # including when a user chooses a rectangular canvas.
    mode: str = "square"
    width: int = 1200
    height: int = 1200
    max_edge: int = 1200


def _validate_dimension(value: object, label: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{label}必须是 {MIN_IMAGE_DIMENSION} 到 {MAX_IMAGE_DIMENSION} 的整数。")
    if not MIN_IMAGE_DIMENSION <= value <= MAX_IMAGE_DIMENSION:
        raise ValueError(f"{label}必须在 {MIN_IMAGE_DIMENSION} 到 {MAX_IMAGE_DIMENSION} 像素之间。")


def validate_options(options: ImageProcessingOptions) -> ImageProcessingOptions:
    """Validate only fields used by the selected policy.

    Original mode deliberately ignores old dimension values: no resizing is
    performed. Fit mode likewise does not use the saved canvas dimensions.
    """
    if not isinstance(options.mode, str) or options.mode not in {"original", "fit", "square"}:
        raise ValueError(f"不支持的图片处理模式：{options.mode}。请选择原图、等比缩小或指定尺寸填充。")
    if options.mode == "fit":
        _validate_dimension(options.max_edge, "图片最长边")
    elif options.mode == "square":
        _validate_dimension(options.width, "图片目标宽度")
        _validate_dimension(options.height, "图片目标高度")
    return options


def options_from_config(config: object) -> ImageProcessingOptions:
    options = ImageProcessingOptions(
        mode=getattr(config, "image_processing_mode", "square"),
        width=getattr(config, "image_target_width", 1200),
        height=getattr(config, "image_target_height", 1200),
        max_edge=getattr(config, "image_max_edge", 1200),
    )
    validate_options(options)
    return options


def describe_options(options: ImageProcessingOptions) -> str:
    validate_options(options)
    if options.mode == "original":
        return "原图上传（保留原始文件、分辨率和比例）"
    if options.mode == "fit":
        return f"等比缩小（最长边 {options.max_edge} 像素，不放大、不补白，转 JPG）"
    return f"指定尺寸填充（{options.width}×{options.height} 像素，等比缩放、白底补齐、不裁剪，转 JPG）"


def _existing_source(source: Path) -> Path:
    source = Path(source)
    if not source.is_file():
        raise ValueError(f"图片文件不存在或不是文件：{source}")
    return source


def _fit_dimensions(size: tuple[int, int], max_edge: int) -> tuple[int, int]:
    width, height = size
    if max(width, height) <= max_edge:
        return size
    scale = max_edge / max(width, height)
    return max(1, round(width * scale)), max(1, round(height * scale))


def dimensions_for_upload(source: Path, options: ImageProcessingOptions) -> tuple[int, int]:
    """Return display dimensions after EXIF orientation and the chosen policy.

    Metadata inspection avoids decoding full pixels just for the confirmation
    dialog. Original mode keeps the EXIF metadata and file bytes unchanged.
    """
    validate_options(options)
    source = _existing_source(source)
    with Image.open(source) as image:
        width, height = image.size
        if image.getexif().get(0x0112) in {5, 6, 7, 8}:
            width, height = height, width
    if options.mode == "square":
        return options.width, options.height
    if options.mode == "fit":
        return _fit_dimensions((width, height), options.max_edge)
    return width, height


def _white_rgb(image: Image.Image) -> Image.Image:
    if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
        rgba = image.convert("RGBA")
        canvas = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        canvas.alpha_composite(rgba)
        return canvas.convert("RGB")
    return image.convert("RGB")


def prepared_upload_path(source: Path, target: Path, options: ImageProcessingOptions) -> Path:
    """Return an untouched original or generate the requested JPEG at target."""
    validate_options(options)
    source = _existing_source(source)
    if options.mode == "original":
        return source

    target = Path(target)
    if source.resolve() == target.resolve() or (target.exists() and source.samefile(target)):
        raise ValueError("处理后的图片必须保存到其他位置，不能覆盖原图。")
    with Image.open(source) as opened:
        image = _white_rgb(ImageOps.exif_transpose(opened))
        if options.mode == "fit":
            size = _fit_dimensions(image.size, options.max_edge)
            if image.size != size:
                image = image.resize(size, resample=Image.Resampling.LANCZOS)
        else:
            image = ImageOps.pad(
                image,
                (options.width, options.height),
                method=Image.Resampling.LANCZOS,
                color=(255, 255, 255),
                centering=(0.5, 0.5),
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        image.save(target, format="JPEG", quality=95, optimize=True)
    return target
