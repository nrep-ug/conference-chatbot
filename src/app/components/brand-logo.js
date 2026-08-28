"use client";

import Image from "next/image";
import { useState } from "react";

const logoUrl = process.env.NEXT_PUBLIC_NREP_LOGO_URL;

export default function BrandLogo({
  className = "h-11 w-11",
  imageClassName = "",
  priority = false,
}) {
  const [failed, setFailed] = useState(false);

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden bg-white ${className}`}
    >
      {logoUrl && !failed ? (
        <Image
          src={logoUrl}
          alt="NREP"
          width={180}
          height={181}
          sizes="96px"
          priority={priority}
          onError={() => setFailed(true)}
          className={`h-full w-full object-contain ${imageClassName}`}
        />
      ) : (
        <span className="text-xs font-bold text-[#176F91]">NREP</span>
      )}
    </span>
  );
}
