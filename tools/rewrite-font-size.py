"""一次性改写脚本：把正文级字号改成跟随 --fs-base 的相对值。

背景：设置里新增了「字号」滑块，但如果 CSS 里全是写死的 px，
      滑块调了也不会有任何变化。这个脚本把 <=15px 的字号
      统一换成 calc(var(--fs-base) * 系数)。

      只动正文级的字号（10 ~ 15px），18px 以上的大标题与数字保持不变，
      避免调大字号时把版式撑坏。

系数 = 原字号 / 13.5（13.5px 是原来的 body 基准字号），
所以默认值下渲染结果与改动前完全一致。
"""
import io
import re
import glob

RATIO = {
    '10px': 0.741,
    '10.5px': 0.778,
    '11px': 0.815,
    '11.5px': 0.852,
    '12px': 0.889,
    '12.5px': 0.926,
    '12.8px': 0.948,
    '13px': 0.963,
    '13.5px': 1.0,
    '14px': 1.037,
    '14.5px': 1.074,
    '15px': 1.111,
}

PATTERN = re.compile(r'font-size:\s*([0-9.]+px)')


def main():
    files = [f for f in glob.glob('src/renderer/css/*.css')
             if not f.endswith('appearance.css')]
    total = 0

    for f in files:
        with io.open(f, encoding='utf-8') as fh:
            src = fh.read()

        before = len(PATTERN.findall(src))
        counter = {'n': 0}

        def rep(m):
            val = m.group(1)
            if val in RATIO:
                counter['n'] += 1
                return 'font-size: calc(var(--fs-base) * %s)' % RATIO[val]
            return m.group(0)

        out = PATTERN.sub(rep, src)
        after = len(PATTERN.findall(out))

        with io.open(f, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(out)

        total += counter['n']
        print('%-36s 改写 %3d 处，保留固定值 %3d 处' % (f, counter['n'], after))

    print('\n合计改写 %d 处' % total)


if __name__ == '__main__':
    main()
