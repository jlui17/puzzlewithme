"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import type { TiltView } from "../board/tilt";
import type { TableHandle } from "./table-handle";
import { sizeTable } from "./table-size";

export const HOME_TILT_DEG = 28;
export const ROOM_TILT_DEG = 12;

/** scene.css's phone breakpoint: there the table lies flat, full width, with no floor or edge. */
const PHONE_QUERY = "(max-width: 760px)";

/**
 * The table every screen sits on: a plane tilted about its far edge, seen
 * through a perspective view whose origin is at the window, over a floor,
 * with the thickness of the top along its near edge. Children lie on the
 * plane. The board tilts it through `ref` (TableHandle); `tilt` is where it
 * starts, in degrees.
 */
export function Table({
  tilt,
  growWithContent = false,
  children,
  ref,
}: {
  tilt: number;
  /** The home: the plane grows with its content and the page scrolls. Otherwise it fits the screen. */
  growWithContent?: boolean;
  children: ReactNode;
  ref?: Ref<TableHandle>;
}) {
  const viewRef = useRef<HTMLDivElement>(null);
  const planeRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef(tilt);

  // Sizes the plane and the view for the current tilt and the screen, and
  // returns the view the browser now draws. Reads before writes, so a call
  // per animation frame costs no extra layout in the room.
  const fit = useCallback((): TiltView => {
    const view = viewRef.current!;
    const plane = planeRef.current!;
    const viewStyle = getComputedStyle(view);
    const viewBox = view.getBoundingClientRect();
    const perspective = parseFloat(viewStyle.perspective);
    const tiltView: TiltView = {
      perspective,
      originX: viewBox.width / 2,
      originY: 0,
      // The plane is centred by auto margins; the computed margin keeps the fraction offsetLeft rounds away.
      planeLeft: parseFloat(getComputedStyle(plane).marginLeft),
      planeTop: 0,
      tiltDeg: 0,
    };
    if (matchMedia(PHONE_QUERY).matches) {
      view.style.height = "";
      plane.style.height = "";
    } else {
      if (growWithContent) plane.style.height = "";
      const size = sizeTable({
        space: window.innerHeight - (viewBox.top + window.scrollY),
        content: growWithContent ? plane.offsetHeight : 0,
        tiltDeg: tiltRef.current,
        perspective,
        edge: parseFloat(viewStyle.getPropertyValue("--edge-h")),
        growWithContent,
      });
      tiltView.tiltDeg = size.tiltDeg;
      plane.style.height = `${size.planeHeight}px`;
      view.style.height = `${size.viewHeight}px`;
    }
    view.style.setProperty("--cam", `${tiltView.tiltDeg}deg`);
    return tiltView;
  }, [growWithContent]);

  useImperativeHandle(
    ref,
    (): TableHandle => ({
      setTilt(deg) {
        tiltRef.current = deg;
        return fit();
      },
      // Fits again rather than returning a cached view, so it is fresh even
      // when the caller's resize listener runs before this table's own.
      getTiltView: fit,
    }),
    [fit],
  );

  useLayoutEffect(() => {
    tiltRef.current = tilt;
    fit();
  }, [tilt, fit]);

  useEffect(() => {
    const refit = () => void fit();
    window.addEventListener("resize", refit);
    const observer = new ResizeObserver(refit);
    // The content box stretches to the plane, so it only ever grows; its children follow their content both ways.
    if (growWithContent) for (const child of contentRef.current!.children) observer.observe(child);
    return () => {
      window.removeEventListener("resize", refit);
      observer.disconnect();
    };
  }, [fit, growWithContent]);

  return (
    // The inline tilt draws the first paint tilted, before the layout effect sizes the plane.
    <div className="table-view" ref={viewRef} style={{ "--cam": `${tilt}deg` } as CSSProperties}>
      <div className="floor" aria-hidden="true" />
      <main className="table3d" ref={planeRef}>
        <div className="screen" ref={contentRef}>
          {children}
        </div>
        <div className="table-edge" aria-hidden="true" />
      </main>
    </div>
  );
}
