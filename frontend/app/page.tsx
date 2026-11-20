"use client";

import { useEffect, useMemo, useState } from "react";

// API calls go to /api on this site (forwarded to the backend, see next.config.ts)
const API = "";

interface Shape {
  page: number;
  tag: string;
  beam: string | null;
  beam_size: string | null;
  also_in: string[];
  shape: string;
  type: string;
  length_mm: number;
  segments_mm: number[];
  imageUrl: string | null;
}

interface PageInfo {
  page: number;
  bars_from: string;
  overlayUrl: string;
  mm_per_pt: number;
  scale_from: string;
  depth_check?: string;
  depth_status?: "confirmed" | "exaggerated" | "mismatch" | "unchecked" | "corrected";
}

// One image shown in the pop-up card
interface ViewItem {
  src: string;
  title: string;
  lines: string[];
}

interface Result {
  jobId: string;
  xlsxUrl: string;
  pages: PageInfo[];
  shapes: Shape[];
}

// "B47 (300x600) + B48" for a bar of B47 that runs on into B48
function beamText(s: Shape): string {
  if (!s.beam) return "no beam";
  return `${s.beam}${s.beam_size ? ` (${s.beam_size})` : ""}${s.also_in.length ? ` + ${s.also_in.join(", ")}` : ""}`;
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [type, setType] = useState("all");
  const [beam, setBeam] = useState("all");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<{ items: ViewItem[]; i: number } | null>(null);

  async function analyze(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setLoading(true);
    setError("");
    setResult(null);
    setType("all");
    setBeam("all");
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch(`${API}/api/analyze`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? res.statusText);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const types = useMemo(() => [...new Set(result?.shapes.map((s) => s.type))], [result]);
  // Shapes come grouped by beam (B1, B2, ... B10), so first-seen order is the natural order
  const beams = useMemo(() => [...new Set(result?.shapes.map((s) => s.beam ?? "(no beam)"))], [result]);
  const shown = useMemo(
    () =>
      (result?.shapes ?? []).filter(
        (s) =>
          (type === "all" || s.type === type) &&
          (beam === "all" || (s.beam ?? "(no beam)") === beam || s.also_in.includes(beam)) &&
          `${s.tag} ${s.beam ?? ""} ${s.shape} ${s.length_mm}`.toLowerCase().includes(search.toLowerCase()),
      ),
    [result, type, beam, search],
  );
  const shapeItems: ViewItem[] = shown.map((s) => ({
    src: `${API}${s.imageUrl}`,
    title: `${s.tag} · ${s.beam ?? "no beam"} · ${s.shape}`,
    lines: [`Beam: ${beamText(s)}`, `Length: ${s.length_mm} mm`, `Legs: ${s.segments_mm.join(" + ")} mm`, `Type: ${s.type} · page ${s.page}`],
  }));

  const step = (d: number) =>
    setView((v) => (v ? { ...v, i: (v.i + d + v.items.length) % v.items.length } : v));

  useEffect(() => {
    if (!view) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setView(null);
      if (e.key === "ArrowRight") step(1);
      if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [view]);

  const current = view ? view.items[view.i] : null;


  return (
    <main>
      <h1>Rebar Shape Finder</h1>
      <p className="sub">Upload a CAD PDF to get every bar shape with its length.</p>

      <section className="panel">
        <form onSubmit={analyze}>
          <label>
            PDF file
            <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <button type="submit" disabled={!file || loading}>
            {loading ? "Analyzing…" : "Analyze"}
          </button>
        </form>
        {error && <p className="error">{error}</p>}
      </section>

      {result && (
        <>
          <section className="panel stats">
            <div><b>{result.shapes.length}</b><span>shapes</span></div>
            <div>
              <a href={`${API}${result.xlsxUrl}`} download>Download Excel (with images)</a>
              {result.pages.map((p) => (
                <span key={p.page}>
                  {" · "}
                  <button
                    className="link"
                    onClick={() =>
                      setView({
                        items: [{ src: `${API}${p.overlayUrl}`, title: `Page ${p.page} overlay`, lines: [] }],
                        i: 0,
                      })
                    }
                  >
                    Page {p.page} overlay
                  </button>
                </span>
              ))}
            </div>
          </section>

          {result.pages.map((p) => (
            <p key={p.page} className={p.depth_status === "exaggerated" || p.depth_status === "mismatch" ? "error" : "note"}>
              Page {p.page}: scale {p.mm_per_pt} mm/pt ({p.scale_from}).{" "}
              {p.depth_check && <>Beam depth check: {p.depth_check}.</>}
            </p>
          ))}

          <div className="toolbar">
            <select value={beam} onChange={(e) => setBeam(e.target.value)}>
              <option value="all">All beams</option>
              {beams.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="all">All types</option>
              {types.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input className="small" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>

          <div className="grid">
            {shown.map((s, idx) => (
              <div className="card" key={`${s.page}-${s.tag}`}>
                {s.imageUrl && (
                  <button className="thumb" onClick={() => setView({ items: shapeItems, i: idx })}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`${API}${s.imageUrl}`} alt={`${s.tag} ${s.shape}`} loading="lazy" />
                  </button>
                )}
                <div className="info">
                  <div className="len">{s.length_mm} mm</div>
                  <div><b>{beamText(s)}</b></div>
                  <div>{s.tag} · {s.shape}</div>
                  <div className="meta">Legs: {s.segments_mm.join(" + ")} mm · page {s.page}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {view && current && (
        <div className="modal" onClick={() => setView(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <b>{current.title}</b>
              <button className="close" onClick={() => setView(null)} aria-label="Close">×</button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={current.src} alt={current.title} />
            {current.lines.length > 0 && (
              <div className="modal-info">
                {current.lines.map((l) => <div key={l}>{l}</div>)}
              </div>
            )}
            {view.items.length > 1 && (
              <div className="modal-nav">
                <button onClick={() => step(-1)}>‹ Prev</button>
                <span>{view.i + 1} / {view.items.length}</span>
                <button onClick={() => step(1)}>Next ›</button>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
