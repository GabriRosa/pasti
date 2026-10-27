/** Slice areas represent energy from macros (4/4/9 kcal per gram). Labels show grams. */
export const MACRO_CHART_KEYS = [
  { key: 'protein', name: 'Proteine', color: '#cc3434', factor: 4 },
  { key: 'fat', name: 'Grassi', color: '#f4ce46', factor: 9 },
  { key: 'carbs', name: 'Carboidrati', color: '#cccccc', factor: 4 },
];
export function macroGrams(value) {
  return value > 0 && value < 0.1 ? '<0,1' : value.toLocaleString('it-IT', { maximumFractionDigits: 1 });
}
export function macroChartSvg(macros) {
  const slices = MACRO_CHART_KEYS.map(item => ({ ...item, grams: macros[item.key] }));
  if (slices.some(item => !Number.isFinite(item.grams) || item.grams < 0)) throw new Error('Macro del grafico non validi.');
  const total = slices.reduce((sum, item) => sum + item.grams * item.factor, 0);
  const cx = 150, cy = 120, radius = 88;
  const point = (angle, r) => [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
  const paths = [], labels = [], callouts = [];
  let start = -Math.PI / 2;
  for (const item of slices) {
    if (!item.grams || !total) continue;
    const fraction = item.grams * item.factor / total;
    const angle = fraction * Math.PI * 2;
    const end = start + angle;
    const a = point(start, radius), b = point(end, radius);
    const title = `${item.name}: ${macroGrams(item.grams).replace('<', '&lt;')} g`;
    paths.push(fraction > 0.999999
      ? `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${item.color}"><title>${title}</title></circle>`
      : `<path d="M ${cx} ${cy} L ${a.join(' ')} A ${radius} ${radius} 0 ${angle > Math.PI ? 1 : 0} 1 ${b.join(' ')} Z" fill="${item.color}"><title>${title}</title></path>`);
    const middle = start + angle / 2;
    if (fraction >= 0.085) {
      const [x, y] = point(middle, fraction > 0.999999 ? 0 : radius * 0.67);
      labels.push(`<text x="${x}" y="${y}" fill="${item.key === 'protein' ? '#ffffff' : '#202020'}">${macroGrams(item.grams).replace('<', '&lt;')} g</text>`);
    } else {
      // A real, narrow wedge cannot contain a readable label; use a linked callout.
      callouts.push({ item, middle });
    }
    start = end;
  }
  callouts.forEach(({ item, middle }, index) => {
    const [x, y] = point(middle, radius * .9);
    const targetY = 18 + index * 22;
    labels.push(`<path d="M ${x} ${y} L 246 ${targetY}" fill="none" stroke="#777777" stroke-width="1"/><rect x="242" y="${targetY - 12}" width="57" height="23" rx="6" fill="${item.color}" stroke="#777777" stroke-width=".7"/><text x="270" y="${targetY}" fill="${item.key === 'protein' ? '#ffffff' : '#202020'}">${macroGrams(item.grams).replace('<', '&lt;')} g</text>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 225"><g stroke="#7a7a7a" stroke-width="1">${total ? paths.join('') : `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="#2a2a2a"/>`}</g><g font-family="system-ui, sans-serif" font-size="19" font-weight="650" text-anchor="middle" dominant-baseline="middle">${total ? labels.join('') : `<text x="${cx}" y="${cy}" fill="#eeeeee">0 g</text>`}</g></svg>`;
}
