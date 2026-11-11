import type { TiltView } from "../board/tilt";

/**
 * What the Table gives the board. The tilt follows the board's zoom every
 * frame, so the board drives it through this handle instead of React props.
 */
export interface TableHandle {
  /** Tilt the plane to `deg` and return the view the browser now draws. On a phone the plane stays flat. */
  setTilt(deg: number): TiltView;
  /** The view the browser draws right now (it also changes when the window resizes). */
  getTiltView(): TiltView;
}
