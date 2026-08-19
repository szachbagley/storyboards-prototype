/** Fixed 16:9 box so grids do not reflow as images load. */
export function ImageTile({ src, alt, empty = "No image" }: { src: string | null; alt: string; empty?: string }) {
  return (
    <div className="tile-image">
      {src ? <img src={src} alt={alt} loading="lazy" /> : <span className="tile-empty">{empty}</span>}
    </div>
  );
}
