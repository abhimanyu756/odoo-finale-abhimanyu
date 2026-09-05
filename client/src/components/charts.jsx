import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, LabelList,
} from 'recharts';
import { compactMoney, money } from '../lib/format';

/*
 * Palette validated with the dataviz validator (light surface #ffffff):
 * the four categorical slots pass CVD and normal-vision separation on the
 * adjacent pairlist. Single-series charts use the Odoo plum instead, where
 * separation does not apply. Three slots sit under 3:1 contrast, so every
 * chart here also carries direct labels or a table view (the relief rule).
 */
export const SERIES = {
  primary: '#714B67',
  slot1: '#2a78d6',
  slot2: '#eb6834',
  slot3: '#1baf7a',
  slot4: '#eda100',
};

export const STATUS = {
  good: '#1baf7a',
  warning: '#eda100',
  critical: '#e34948',
};

const AXIS = { fontSize: 11, fill: '#6b7280' };
const GRID = '#eef0f2';

function TooltipCard({ active, payload, label, formatter }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-hairline bg-white px-2.5 py-1.5 text-xs shadow-lg">
      <p className="mb-0.5 font-medium text-ink">{label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="flex items-center gap-1.5 text-ink-soft">
          <span className="h-2 w-2 rounded-sm" style={{ background: p.color ?? p.fill }} />
          {p.name}: <span className="font-medium text-ink">{formatter ? formatter(p.value) : p.value}</span>
        </p>
      ))}
    </div>
  );
}

// Magnitude by category, one series: a single hue, value labels at the bar end.
// `onSelect` makes the bars a navigation control - clicking one drills into that
// category - so the chart doubles as the entry point to the detail panel.
export function CategoryBarChart({
  data,
  valueKey = 'net',
  name = 'Net salary',
  format = compactMoney,
  tooltipFormat = money,
  onSelect,
  labelWidth = 118,
}) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(180, data.length * 42)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 68, bottom: 4, left: 4 }}>
        <CartesianGrid horizontal={false} stroke={GRID} />
        <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={format} />
        <YAxis type="category" dataKey="label" width={labelWidth}
          tick={AXIS} tickLine={false} axisLine={false} />
        <Tooltip cursor={{ fill: '#f6f2f5' }} content={<TooltipCard formatter={tooltipFormat} />} />
        <Bar
          dataKey={valueKey}
          name={name}
          fill={SERIES.primary}
          radius={[0, 4, 4, 0]}
          barSize={18}
          cursor={onSelect ? 'pointer' : undefined}
          onClick={onSelect ? (entry) => onSelect(entry?.payload ?? entry) : undefined}
        >
          <LabelList dataKey={valueKey} position="right" formatter={format}
            style={{ fontSize: 11, fill: '#1f2937', fontWeight: 500 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// Change over time, one series: 2px line, 8px markers, crosshair tooltip.
export function NetSalaryTrend({ data, onSelectMonth }) {
  return (
    <ResponsiveContainer width="100%" height={230}>
      <LineChart
        data={data}
        margin={{ top: 16, right: 20, bottom: 4, left: 4 }}
        // Clicking anywhere on the plot resolves to the nearest month, which is
        // a far bigger hit target than the 4px dots.
        onClick={onSelectMonth
          ? (state) => {
              const point = state?.activePayload?.[0]?.payload;
              if (point) onSelectMonth(point);
            }
          : undefined}
        style={onSelectMonth ? { cursor: 'pointer' } : undefined}
      >
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={compactMoney} width={54} />
        <Tooltip cursor={{ stroke: '#d4bfcd', strokeWidth: 1 }}
          content={<TooltipCard formatter={(v) => money(v)} />} />
        <Line
          type="monotone" dataKey="net" name="Net salary"
          stroke={SERIES.primary} strokeWidth={2}
          dot={{ r: 4, fill: '#fff', stroke: SERIES.primary, strokeWidth: 2 }}
          activeDot={{ r: 6, fill: SERIES.primary, stroke: '#fff', strokeWidth: 2 }}
        >
          <LabelList dataKey="net" position="top" formatter={compactMoney}
            style={{ fontSize: 10, fill: '#6b7280' }} />
        </Line>
      </LineChart>
    </ResponsiveContainer>
  );
}

// Composition of one whole. Status colours are reserved and always paired with
// a label, so identity never rests on colour alone.
export function AttendanceComposition({ overview, onSelect }) {
  const parts = [
    { key: 'PRESENT', label: 'Present', value: overview.present, color: STATUS.good },
    { key: 'LATE', label: 'Late', value: overview.late, color: STATUS.warning },
    { key: 'MISSING_CHECKOUT', label: 'Absent / No check-out',
      value: overview.absent + overview.missingCheckout, color: STATUS.critical },
  ];
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const pct = (v) => (v / total) * 100;

  return (
    <div>
      {/* 2px surface gaps between segments, per the mark spec */}
      <div className="flex h-6 gap-0.5 overflow-hidden rounded">
        {parts.map((p) => (
          <button
            key={p.key}
            type="button"
            disabled={!onSelect || !p.value}
            title={`${p.label}: ${p.value}`}
            onClick={() => onSelect?.(p)}
            style={{ width: `${pct(p.value)}%`, background: p.color }}
            className="first:rounded-l last:rounded-r transition-opacity enabled:cursor-pointer enabled:hover:opacity-80"
          />
        ))}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {parts.map((p) => (
          <button
            key={p.key}
            type="button"
            disabled={!onSelect || !p.value}
            onClick={() => onSelect?.(p)}
            className="flex items-baseline gap-2 rounded-md p-1 text-left transition-colors
                       enabled:cursor-pointer enabled:hover:bg-odoo-50 disabled:cursor-default"
          >
            <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: p.color }} />
            <span>
              <span className="block text-base font-semibold leading-tight text-ink">
                {p.value}
                <span className="ml-1 text-xs font-normal text-ink-soft">{pct(p.value).toFixed(0)}%</span>
              </span>
              <span className="block text-xs text-ink-soft">{p.label}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
