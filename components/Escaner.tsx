"use client";

import { useEffect, useRef, useState } from "react";

// Lector de códigos de barras con la cámara del celular (ZXing, funciona en Android e iPhone)
export default function Escaner({
  onLectura,
  pausado,
}: {
  onLectura: (texto: string, formato: string) => void;
  pausado: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const pausadoRef = useRef(pausado);
  const onLecturaRef = useRef(onLectura);
  const [error, setError] = useState<string | null>(null);
  const [linterna, setLinterna] = useState<null | ((on: boolean) => Promise<void>)>(null);
  const [linternaOn, setLinternaOn] = useState(false);

  pausadoRef.current = pausado;
  onLecturaRef.current = onLectura;

  useEffect(() => {
    let controles: { stop: () => void } | null = null;
    let cancelado = false;

    (async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setError("La cámara solo funciona con la app abierta por https (desde la dirección de Vercel).");
        return;
      }
      const { BrowserMultiFormatReader } = await import("@zxing/browser");
      const { BarcodeFormat, DecodeHintType } = await import("@zxing/library");
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.ITF,
        BarcodeFormat.DATA_MATRIX, BarcodeFormat.QR_CODE, BarcodeFormat.PDF_417,
        BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
      ]);
      hints.set(DecodeHintType.TRY_HARDER, true);
      const lector = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 120, delayBetweenScanSuccess: 700 });
      try {
        const c = await lector.decodeFromConstraints(
          { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } },
          video.current!,
          (resultado) => {
            if (resultado && !pausadoRef.current) {
              onLecturaRef.current(resultado.getText(), BarcodeFormat[resultado.getBarcodeFormat()]);
            }
          }
        );
        if (cancelado) { c.stop(); return; }
        controles = c;
        if (c.switchTorch) setLinterna(() => c.switchTorch!);
      } catch (e: any) {
        setError(
          e?.name === "NotAllowedError"
            ? "No diste permiso para usar la cámara. Habilitalo en la configuración del navegador (ícono del candado junto a la dirección) y recargá la página."
            : e?.name === "NotFoundError"
              ? "No se encontró una cámara en este dispositivo."
              : `No se pudo abrir la cámara: ${e?.message ?? e}`
        );
      }
    })();

    return () => { cancelado = true; controles?.stop(); };
  }, []);

  if (error) {
    return <div className="rounded-xl bg-red-50 text-red-700 text-sm p-4" role="alert">{error}</div>;
  }

  return (
    <div className="relative rounded-xl overflow-hidden bg-black aspect-[4/3]">
      <video ref={video} className="w-full h-full object-cover" muted playsInline />
      {/* Guía para apuntar */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className={`w-[82%] h-[38%] rounded-lg border-2 ${pausado ? "border-white/30" : "border-[#F2C230]"} shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]`} />
      </div>
      <p className="absolute bottom-2 inset-x-0 text-center text-xs text-white/90">
        {pausado ? "Lectura en pausa" : "Apuntá al código de barras que dice S/N o Serial"}
      </p>
      {linterna && (
        <button
          type="button"
          onClick={async () => { await linterna(!linternaOn); setLinternaOn(!linternaOn); }}
          className="absolute top-2 right-2 rounded-full bg-black/60 text-white text-xs px-3 py-1.5"
          aria-pressed={linternaOn}
        >
          {linternaOn ? "Apagar linterna" : "Linterna"}
        </button>
      )}
    </div>
  );
}
