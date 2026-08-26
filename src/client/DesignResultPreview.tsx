import type { ReactNode } from "react";

import type { DesignResourceWire } from "./contracts.js";
import { designResourcePreviewMessageKey } from "./design-presentation.js";
import type { ModellixTranslate } from "./shared.js";

const NO_REFERRER_ATTRIBUTE = { referrerPolicy: "no-referrer" } as const;

export function DesignResultPreview({
  resource,
  t,
}: {
  readonly resource: DesignResourceWire;
  readonly t: ModellixTranslate;
}): ReactNode {
  const accessibleName = t(designResourcePreviewMessageKey(resource.kind));
  if (resource.kind === "image") {
    return (
      <img
        className="mdlx-media"
        src={resource.url}
        alt={accessibleName}
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  }
  if (resource.kind === "video") {
    return (
      <video
        {...NO_REFERRER_ATTRIBUTE}
        className="mdlx-media"
        src={resource.url}
        aria-label={accessibleName}
        controls
        playsInline
        preload="metadata"
      />
    );
  }
  return (
    <audio
      {...NO_REFERRER_ATTRIBUTE}
      className="mdlx-media mdlx-media-audio"
      src={resource.url}
      aria-label={accessibleName}
      controls
      preload="metadata"
    />
  );
}
