"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

// Muestra un QR para abrir el escáner en el celular sin tener que escribir la dirección
export default function AbrirEnCelular() {
  const [abierto, setAbierto] = useState(false);
  const [qr, setQr] = useState("");
  const [url, setUrl] = useState("");

  useEffect(() => {
    if (!abierto) return;
    const u = `${window.location.origin}/inventario/escanear`;
    setUrl(u);
    QRCode.toDataURL(u, { margin: 1, width: 220 }).then(setQr);
  }, [abierto]);

  return (
    <>
      <button className="btn-secondary" onClick={() => setAbierto(true)}>Cargar con el celular</button>
      {abierto && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setAbierto(false)}>
          <div className="card p-6 max-w-sm w-full text-center space-y-3" role="dialog" aria-label="Abrir en el celular" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-display text-xl text-ink">Escaneá con el celular</h2>
            <p className="text-sm text-ink/60">Apuntá la cámara del celular a este código para abrir el escáner de números de serie.</p>
            {qr && <img src={qr} alt="Código QR para abrir el escáner" className="mx-auto" width={220} height={220} />}
            <p className="text-xs text-ink/50 break-all">{url}</p>
            <button className="btn-secondary w-full" onClick={() => setAbierto(false)}>Cerrar</button>
          </div>
        </div>
      )}
    </>
  );
}
