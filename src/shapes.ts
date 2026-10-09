import {
  customSeriesDefaultOptions,
  type CustomData,
  type CustomSeriesOptions,
  type CustomSeriesPricePlotValues,
  type ICustomSeriesPaneRenderer,
  type ICustomSeriesPaneView,
  type PaneRendererCustomData,
  type PriceToCoordinateConverter,
  type Time,
  type WhitespaceData,
} from 'lightweight-charts';
import { DOWN, UP } from './colors';

export interface ShapeData extends CustomData<Time> {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  box?: number;
}

type DrawTarget = Parameters<ICustomSeriesPaneRenderer['draw']>[0];

/**
 * Custom series for the two chart types the library cannot draw natively:
 * volume candles (body width follows volume) and point & figure (X / O columns).
 */
export class ShapeSeries implements ICustomSeriesPaneView<Time, ShapeData, CustomSeriesOptions> {
  private data: PaneRendererCustomData<Time, ShapeData> | null = null;

  constructor(private mode: 'volume' | 'pnf') {}

  priceValueBuilder(d: ShapeData): CustomSeriesPricePlotValues {
    return [d.low, d.high, d.close];
  }
  isWhitespace(d: ShapeData | WhitespaceData<Time>): d is WhitespaceData<Time> {
    return (d as Partial<ShapeData>).close === undefined;
  }
  defaultOptions(): CustomSeriesOptions {
    return { ...customSeriesDefaultOptions };
  }
  update(data: PaneRendererCustomData<Time, ShapeData>) {
    this.data = data;
  }
  renderer(): ICustomSeriesPaneRenderer {
    return { draw: (target, y) => this.draw(target, y) };
  }

  private draw(target: DrawTarget, y: PriceToCoordinateConverter) {
    const d = this.data;
    if (!d?.visibleRange) return;
    const { from, to } = d.visibleRange;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const slot = d.barSpacing * hr;
      let maxVol = 0;
      for (let i = from; i < to; i++) maxVol = Math.max(maxVol, d.bars[i].originalData.volume);

      for (let i = from; i < to; i++) {
        const o = d.bars[i].originalData;
        const x = d.bars[i].x * hr;
        const up = o.close >= o.open;
        ctx.fillStyle = ctx.strokeStyle = up ? UP : DOWN;

        if (this.mode === 'volume') {
          const w = Math.max(1, slot * (maxVol ? 0.12 + 0.82 * (o.volume / maxVol) : 0.6));
          const hi = (y(o.high) ?? 0) * vr;
          const lo = (y(o.low) ?? 0) * vr;
          const a = (y(o.open) ?? 0) * vr;
          const b = (y(o.close) ?? 0) * vr;
          const wick = Math.max(1, Math.floor(hr));
          ctx.fillRect(Math.round(x - wick / 2), hi, wick, Math.max(1, lo - hi));
          ctx.fillRect(Math.round(x - w / 2), Math.min(a, b), Math.round(w), Math.max(1, Math.abs(a - b)));
          continue;
        }

        const box = o.box ?? 0;
        if (!(box > 0)) continue;
        const cells = Math.max(1, Math.round((o.high - o.low) / box));
        ctx.lineWidth = Math.max(1, 1.5 * hr);
        for (let k = 0; k < cells; k++) {
          const top = (y(o.low + (k + 1) * box) ?? 0) * vr;
          const bottom = (y(o.low + k * box) ?? 0) * vr;
          const cy = (top + bottom) / 2;
          const rx = Math.max(1, Math.min(slot * 0.38, 40 * hr));
          const ry = Math.max(1, (bottom - top) * 0.38);
          ctx.beginPath();
          if (up) {
            ctx.moveTo(x - rx, cy - ry);
            ctx.lineTo(x + rx, cy + ry);
            ctx.moveTo(x + rx, cy - ry);
            ctx.lineTo(x - rx, cy + ry);
          } else {
            ctx.ellipse(x, cy, rx, ry, 0, 0, Math.PI * 2);
          }
          ctx.stroke();
        }
      }
    });
  }
}
