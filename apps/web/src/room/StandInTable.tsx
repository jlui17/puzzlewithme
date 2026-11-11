"use client";

import { useImperativeHandle, useLayoutEffect, useRef, type ReactNode, type Ref } from "react";
import { fitPlaneHeight, type TiltView } from "../board/tilt";
import type { TableHandle } from "../scene/table-handle";

/**
 * STAND-IN for the scene's Table, so the board's tilt can be built and checked
 * before the real Table lands. Delete this file and pass the real Table's
 * handle to BoardCanvas instead.
 *
 * Built and sized like the real one: a perspective view, a plane rotated about
 * its far edge whose near edge, and the edge standing up under it, land at the
 * view's bottom. Flat (tilt 0, or under MIN_TILTED_SPACE) the plane takes the
 * edge's height too. On a phone it lies flat and full width. Every setTilt and
 * getTiltView fits again from the view's current size.
 */
const PERSPECTIVE = 1700;
const TABLE_WIDTH = 0.85;
const EDGE_PX = 33;
const MIN_TILTED_SPACE = 240;
const PHONE = "(max-width: 760px)";
/** The view starts under where the window band will be, so it is not at the page's origin. */
const VIEW_TOP_PX = 96;

export function StandInTable({ ref, tilt, children }: { ref: Ref<TableHandle>; tilt: number; children: ReactNode }) {
  const viewRef = useRef<HTMLDivElement>(null);
  const planeRef = useRef<HTMLDivElement>(null);
  const edgeRef = useRef<HTMLDivElement>(null);
  const requested = useRef(tilt);

  const fit = (): TiltView => {
    const { width, height } = viewRef.current!.getBoundingClientRect();
    const phone = matchMedia(PHONE).matches;
    const available = height - EDGE_PX;
    const flat = phone || requested.current < 0.05 || available < MIN_TILTED_SPACE;
    const tiltDeg = flat ? 0 : requested.current;
    const planeWidth = phone ? width : width * TABLE_WIDTH;
    const planeLeft = (width - planeWidth) / 2;
    const plane = planeRef.current!;
    plane.style.width = `${planeWidth}px`;
    plane.style.marginLeft = `${planeLeft}px`;
    plane.style.height = `${flat ? height : fitPlaneHeight(available, tiltDeg, PERSPECTIVE)}px`;
    plane.style.transform = `rotateX(${tiltDeg}deg)`;
    edgeRef.current!.style.transform = `rotateX(${-tiltDeg}deg)`;
    edgeRef.current!.hidden = flat;
    return { perspective: PERSPECTIVE, originX: width / 2, originY: 0, planeLeft, planeTop: 0, tiltDeg };
  };

  useImperativeHandle(
    ref,
    () => ({
      setTilt: (deg) => {
        requested.current = deg;
        return fit();
      },
      getTiltView: fit,
    }),
    [],
  );

  useLayoutEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={viewRef}
      style={{
        position: "fixed",
        top: VIEW_TOP_PX,
        left: 0,
        right: 0,
        bottom: 0,
        perspective: `${PERSPECTIVE}px`,
        perspectiveOrigin: "50% 0%",
        overflow: "hidden",
        background: "#1c140e",
      }}
    >
      {/* No overflow on the plane: it would flatten the edge. The board's own box clips the canvas. */}
      <div
        ref={planeRef}
        style={{
          position: "relative",
          transformOrigin: "50% 0%",
          transformStyle: "preserve-3d",
          background: "linear-gradient(180deg, #4a3220, #5c3f28 70%)",
        }}
      >
        {children}
        <div
          ref={edgeRef}
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: "100%",
            height: EDGE_PX,
            transformOrigin: "50% 0%",
            background: "linear-gradient(180deg, rgba(255,240,220,.28) 0 2px, #3a281a 4px 45%, #20160e)",
          }}
        />
      </div>
    </div>
  );
}
