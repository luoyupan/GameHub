# -*- coding: utf-8 -*-
"""
GameHub 应用图标生成脚本
用 Pillow 画一个「渐变圆角方块 + 手柄」的图标，并打包成多尺寸 .ico。
4 倍超采样后缩小，得到平滑的抗锯齿边缘。
"""
from PIL import Image, ImageDraw
import os

S = 1024          # 绘制尺寸（超采样）
OUT = 256         # 最终尺寸
SS = 4            # 采样倍率

BLUE = (79, 156, 249)
CYAN = (34, 211, 238)
DARK = (12, 20, 34)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def make_master():
    """先画一张 1024x1024 的主图"""
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # ---------- ① 背景：圆角方块 + 对角渐变 ----------
    # 先用渐变填充整张画布，再用圆角矩形当遮罩裁出来
    grad = Image.new("RGB", (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        for_x = y / (S - 1)
        gd.line([(0, y), (S, y)], fill=lerp(BLUE, CYAN, for_x))

    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=int(S * 0.235), fill=255)
    img.paste(grad, (0, 0), mask)

    # ---------- ② 手柄本体（三个形状的并集） ----------
    body = Image.new("L", (S, S), 0)
    bd = ImageDraw.Draw(body)
    # 中间那块横着的胖矩形
    bd.rounded_rectangle([236, 372, 788, 648], radius=128, fill=255)
    # 左右两个握把
    bd.ellipse([176, 452, 372, 716], fill=255)
    bd.ellipse([652, 452, 848, 716], fill=255)
    # 顶部略微收窄，做成手柄的"肩部"轮廓
    bd.ellipse([300, 348, 724, 560], fill=255)

    white = Image.new("RGBA", (S, S), (255, 255, 255, 255))
    img.paste(white, (0, 0), body)

    # ---------- ③ 手柄上的细节：十字键 + 四颗按键 ----------
    d = ImageDraw.Draw(img)
    cx, cy = 396, 520          # 十字键中心
    arm, wide = 78, 26
    d.rounded_rectangle([cx - wide, cy - arm, cx + wide, cy + arm], radius=wide, fill=DARK)
    d.rounded_rectangle([cx - arm, cy - wide, cx + arm, cy + wide], radius=wide, fill=DARK)

    # 右侧四颗按键（菱形排布）
    bx, by, gap, r = 626, 520, 62, 27
    for dx, dy in [(-gap, 0), (0, -gap), (gap, 0), (0, gap)]:
        d.ellipse([bx + dx - r, by + dy - r, bx + dx + r, by + dy + r], fill=DARK)

    # ---------- ④ 整体缩小到目标尺寸 ----------
    return img.resize((OUT, OUT), Image.LANCZOS)


def main():
    master = make_master()
    here = os.path.dirname(os.path.abspath(__file__))
    # 脚本在 tools/ 下，图标要输出到项目根目录的 build/
    out_dir = os.path.join(os.path.dirname(here), "build")
    os.makedirs(out_dir, exist_ok=True)

    png_path = os.path.join(out_dir, "icon.png")
    master.save(png_path)
    print("已生成 PNG:", png_path)

    ico_path = os.path.join(out_dir, "icon.ico")
    master.save(ico_path, format="ICO",
                sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("已生成 ICO:", ico_path, os.path.getsize(ico_path), "字节")


if __name__ == "__main__":
    main()
