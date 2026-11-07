"use client";

import { useCallback, useState, type DragEvent } from "react";

import { carriesFiles, carriesImage, type FileDragLike } from "./file-drag.ts";

function copyEffect(_event: FileDragLike): DataTransfer["dropEffect"] {
  return "copy";
}

function relatedIsInside(event: DragEvent<HTMLElement>) {
  const related = event.relatedTarget;
  const current = event.currentTarget;
  return (
    related instanceof Node &&
    current instanceof Node &&
    current.contains(related)
  );
}

type FileDropOptions = {
  /** Which drags this surface owns. Unclaimed ones reach the next listener. */
  claim: (event: FileDragLike) => boolean;
  /** Shown as the dashed cue; independent of `claim` so a covering surface
   *  can swallow a PDF without looking like it will attach. */
  highlight?: (event: FileDragLike) => boolean;
  dropEffect?: (event: FileDragLike) => DataTransfer["dropEffect"];
  onDrop?: (files: File[]) => void;
};

/**
 * Nested file-drop ownership. A surface that `stopPropagation`s a claimed
 * drag is the only listener that sees it — the window-level paper overlay
 * never learns the pointer was over a covering composer.
 */
export function useFileDrop({
  claim,
  highlight = claim,
  dropEffect = copyEffect,
  onDrop,
}: FileDropOptions) {
  const [dragDepth, setDragDepth] = useState(0);
  const [cue, setCue] = useState(false);

  const enter = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!claim(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = dropEffect(event);
      setCue(highlight(event));
      // Entering a child bubbles here too; relatedTarget says we were already
      // inside, so counting it would flash the cue off as the pointer moves
      // from the dimmed backdrop onto the card.
      if (relatedIsInside(event)) return;
      setDragDepth((depth) => depth + 1);
    },
    [claim, dropEffect, highlight],
  );

  const over = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!claim(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = dropEffect(event);
    },
    [claim, dropEffect],
  );

  const leave = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!claim(event)) return;
      event.stopPropagation();
      if (relatedIsInside(event)) return;
      setDragDepth((depth) => Math.max(0, depth - 1));
    },
    [claim],
  );

  const drop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!claim(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setDragDepth(0);
      setCue(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) onDrop?.(files);
    },
    [claim, onDrop],
  );

  return {
    active: dragDepth > 0 && cue,
    handlers: {
      onDragEnter: enter,
      onDragOver: over,
      onDragLeave: leave,
      onDrop: drop,
    },
  };
}

/** Docked chat: claim images so they attach, and let a PDF reach the library. */
export function useImageDrop(onFiles: (files: File[]) => void) {
  return useFileDrop({
    claim: carriesImage,
    onDrop: onFiles,
  });
}

/**
 * A covering surface (the floating composer and its backdrop) owns every
 * file drag while it is up. Images attach; anything else is swallowed, so
 * the library overlay cannot paint over a question still being written.
 * Dismiss the surface to add a PDF.
 */
export function useCoveringFileDrop(onImages: (files: File[]) => void) {
  return useFileDrop({
    claim: carriesFiles,
    highlight: carriesImage,
    dropEffect: (event) => (carriesImage(event) ? "copy" : "none"),
    onDrop: (files) => {
      const images = files.filter((file) => file.type.startsWith("image/"));
      if (images.length) onImages(images);
    },
  });
}
