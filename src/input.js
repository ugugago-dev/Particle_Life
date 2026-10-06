// Pointer in world coordinates: left drag / touch attracts, right drag / shift+drag repels (canvas only, so the GUI never triggers it)

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {{pointer: {x:number, y:number, active:boolean, mode:number}, dispose: () => void}} pointer is mutated in place
 */
export function createInput(canvas) {
    const pointer = { x: 0, y: 0, active: false, mode: 1 };
    let activeId = null;

    function updatePosition(e) {
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.height;
        const y = (e.clientY - rect.top) / rect.height;
        pointer.x = Math.min(Math.max(x, 0), rect.width / rect.height);
        pointer.y = Math.min(Math.max(y, 0), 1);
    }

    function updateMode(e) {
        const rightButton = e.button === 2 || (e.buttons & 2) !== 0;
        pointer.mode = rightButton || e.shiftKey ? -1 : 1;
    }

    function release(e) {
        if (e.pointerId !== activeId) return;
        activeId = null;
        pointer.active = false;
    }

    function onDown(e) {
        if (activeId !== null) return; // first finger / button wins
        activeId = e.pointerId;
        canvas.setPointerCapture(e.pointerId);
        updateMode(e);
        updatePosition(e);
        pointer.active = true;
        e.preventDefault();
    }

    function onMove(e) {
        if (e.pointerId !== activeId) return;
        updateMode(e); // allows switching button / shift mid-drag
        updatePosition(e);
    }

    const onContextMenu = (e) => e.preventDefault();

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('lostpointercapture', release);
    canvas.addEventListener('contextmenu', onContextMenu);

    return {
        pointer,
        dispose() {
            canvas.removeEventListener('pointerdown', onDown);
            canvas.removeEventListener('pointermove', onMove);
            canvas.removeEventListener('pointerup', release);
            canvas.removeEventListener('pointercancel', release);
            canvas.removeEventListener('lostpointercapture', release);
            canvas.removeEventListener('contextmenu', onContextMenu);
        },
    };
}
