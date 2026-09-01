/** Offscreen HTML → JPEG → PDF. Avoids chrome.debugger (no “debugging” infobar). */

function detectPaper(html) {
  const blob = String(html || "");
  if (/size\s*:\s*Letter/i.test(blob) || /width:\s*8\.5in/i.test(blob)) {
    return { format: "letter", widthPt: 612, heightPt: 792, iframeWidth: 816 };
  }
  return { format: "a4", widthPt: 595.28, heightPt: 841.89, iframeWidth: 794 };
}

function pad(n, width) {
  const s = String(n);
  return s.length >= width ? s : "0".repeat(width - s.length) + s;
}

function buildPdfFromJpeg({ jpegBytes, pixelWidth, pixelHeight, pageWidthPt, pageHeightPt }) {
  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = [0];
  let size = 0;

  const pushBytes = (bytes) => {
    chunks.push(bytes);
    size += bytes.length;
  };
  const pushText = (text) => pushBytes(encoder.encode(text));

  const startObj = (id) => {
    offsets[id] = size;
    pushText(`${id} 0 obj\n`);
  };
  const endObj = () => pushText("\nendobj\n");

  const imgWidthPt = pageWidthPt;
  const imgHeightPt = (pixelHeight / pixelWidth) * pageWidthPt;
  const pageCount = Math.max(1, Math.ceil(imgHeightPt / pageHeightPt - 0.002));
  const pageIds = Array.from({ length: pageCount }, (_, i) => 4 + i * 2);
  const contentIds = Array.from({ length: pageCount }, (_, i) => 5 + i * 2);

  pushText("%PDF-1.4\n%\x80\x80\x80\x80\n");

  startObj(1);
  pushText("<< /Type /Catalog /Pages 2 0 R >>");
  endObj();

  startObj(2);
  pushText(`<< /Type /Pages /Count ${pageCount} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`);
  endObj();

  startObj(3);
  pushText(
    `<< /Type /XObject /Subtype /Image /Width ${pixelWidth} /Height ${pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`
  );
  pushBytes(jpegBytes);
  pushText("\nendstream");
  endObj();

  for (let i = 0; i < pageCount; i += 1) {
    const yShift = -i * pageHeightPt;
    const content = `q\n${imgWidthPt.toFixed(2)} 0 0 ${imgHeightPt.toFixed(2)} 0 ${yShift.toFixed(2)} cm\n/Im0 Do\nQ\n`;
    startObj(pageIds[i]);
    pushText(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidthPt.toFixed(2)} ${pageHeightPt.toFixed(2)}] /Resources << /XObject << /Im0 3 0 R >> >> /Contents ${contentIds[i]} 0 R >>`
    );
    endObj();
    startObj(contentIds[i]);
    pushText(`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream`);
    endObj();
  }

  const xrefOffset = size;
  const objCount = 4 + pageCount * 2;
  pushText(`xref\n0 ${objCount}\n`);
  pushText("0000000000 65535 f \n");
  for (let id = 1; id < objCount; id += 1) {
    pushText(`${pad(offsets[id] || 0, 10)} 00000 n \n`);
  }
  pushText(`trailer\n<< /Size ${objCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  let binary = "";
  const slice = 8192;
  for (let i = 0; i < out.length; i += slice) {
    binary += String.fromCharCode.apply(null, out.subarray(i, i + slice));
  }
  return btoa(binary);
}

function dataUrlToBytes(dataUrl) {
  const base64 = String(dataUrl || "").split(",")[1] || "";
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function loadIframe(html) {
  const iframe = document.getElementById("frame");
  const paper = detectPaper(html);
  iframe.style.width = `${paper.iframeWidth}px`;
  iframe.style.height = "200px";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out loading resume HTML.")), 20000);
    iframe.onload = async () => {
      clearTimeout(timer);
      try {
        const doc = iframe.contentDocument;
        if (!doc) throw new Error("PDF frame did not load.");
        try {
          await doc.fonts.ready;
        } catch {
          /* ignore */
        }
        const height = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0, 400);
        iframe.style.height = `${height}px`;
        await new Promise((r) => setTimeout(r, 120));
        resolve({ doc, paper });
      } catch (err) {
        reject(err);
      }
    };
    iframe.srcdoc = html;
  });
}

async function htmlToPdfBase64(html) {
  const { doc, paper } = await loadIframe(html);
  const target = doc.body || doc.documentElement;
  const canvas = await (window.html2canvas || html2canvas)(target, {
    scale: 2,
    useCORS: true,
    backgroundColor: "#ffffff",
    logging: false,
    windowWidth: paper.iframeWidth,
    windowHeight: target.scrollHeight
  });
  const jpegUrl = canvas.toDataURL("image/jpeg", 0.93);
  return buildPdfFromJpeg({
    jpegBytes: dataUrlToBytes(jpegUrl),
    pixelWidth: canvas.width,
    pixelHeight: canvas.height,
    pageWidthPt: paper.widthPt,
    pageHeightPt: paper.heightPt
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "ocean_html_to_pdf") return undefined;
  // #region agent log
  fetch("http://127.0.0.1:7779/ingest/d1be8714-c21e-4091-a0f5-4508d30396e2", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "df7ed5" },
    body: JSON.stringify({
      sessionId: "df7ed5",
      runId: "pre-fix",
      hypothesisId: "A,E",
      location: "pdf-render.js:onMessage",
      message: "offscreen PDF request received",
      data: {
        htmlLength: String(message.html || "").length,
        hasOceanPdfAttr: /data-ocean-pdf\s*=\s*["']1["']/i.test(String(message.html || "")),
        hasPreviewShell: /class="page"|preview-frame|doc-toolbar/i.test(String(message.html || ""))
      },
      timestamp: Date.now()
    })
  }).catch(() => {});
  // #endregion
  htmlToPdfBase64(message.html || "")
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});
