// 没入モード: 操作が止まるとツールバーとステータスを隠す。画面下端のタップで戻る

const IDLE_MS = 4000;

/**
 * @param {{toolbar: HTMLElement, edge: HTMLElement, isBusy: () => boolean}} o isBusy: シート表示中や指が canvas 上のとき真
 */
export function createImmersive({ toolbar, edge, isBusy }) {
    let timer = 0;
    let hidden = false;

    function apply(next) {
        hidden = next;
        document.body.classList.toggle('immersive', hidden);
        toolbar.inert = hidden; // 隠れている間はフォーカス / タップを受けない
        edge.hidden = !hidden;
    }

    function arm() {
        clearTimeout(timer);
        timer = setTimeout(() => {
            if (isBusy()) arm(); // 使用中は延ばす
            else apply(true);
        }, IDLE_MS);
    }

    /** 操作があった: 表示して計時をやり直す */
    function poke() {
        if (hidden) apply(false);
        arm();
    }

    toolbar.addEventListener('pointerdown', arm);
    toolbar.addEventListener('focusin', poke);
    edge.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        poke();
    });
    edge.addEventListener('click', (e) => e.stopPropagation());
    apply(false);
    arm();
    return { poke };
}
