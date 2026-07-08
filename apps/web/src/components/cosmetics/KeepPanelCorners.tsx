/**
 * `<KeepPanelCorners />`, renders the two bottom-corner ornament
 * spans that the `.keep-panel-corners` CSS rules expect as children.
 *
 * CSS pseudo-elements can only provide two corners (::before / ::after),
 * so the bottom-left + bottom-right corners need real DOM nodes. Drop
 * this component inside any panel that wears `.keep-panel-corners`
 * and the four-corner frame paints automatically.
 *
 * The spans are `aria-hidden` purely-decorative and have no content;
 * they exist only to anchor the corner background-image via CSS.
 */
export function KeepPanelCorners() {
  return (
    <>
      <span aria-hidden className="keep-corner-bl" />
      <span aria-hidden className="keep-corner-br" />
    </>
  );
}
