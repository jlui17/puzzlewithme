import { useEffect, useRef } from "react";

/** The layers Escape closes (the picture, Who's here, the finish card), oldest first. */
export class EscapeLayers {
  private readonly layers: (() => void)[] = [];

  /** Opens a layer on top of the others; returns what closes it out of the stack. */
  open(close: () => void): () => void {
    this.layers.push(close);
    return () => {
      const i = this.layers.indexOf(close);
      if (i >= 0) this.layers.splice(i, 1);
    };
  }

  /** Closes only the newest open layer. */
  closeTopmost(): void {
    this.layers.at(-1)?.();
  }
}

const roomLayers = new EscapeLayers();
let listening = false;

function onKeyDown(e: KeyboardEvent): void {
  // Escape in a text field (cancelling a rename) belongs to the field.
  if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) roomLayers.closeTopmost();
}

/** While the calling component is mounted it is an open layer: Escape closes it unless one opened later is still open. */
export function useEscapeToClose(close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!listening) {
      window.addEventListener("keydown", onKeyDown);
      listening = true;
    }
    return roomLayers.open(() => closeRef.current());
  }, []);
}
