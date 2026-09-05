import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell, LabelList,
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
export function DepartmentCostChart({ data }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(180, data.length * 42)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 64, bottom: 4, left: 4 }}>
        <CartesianGrid horizontal={false} stroke={GRID} />
        <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false}
          tickFormatter={compactMoney} />
        <YAxis type="category" dataKey="department" width={110}
          tick={AXIS} tickLine={false} axisLine={false} />
        <Tooltip cursor={{ fill: '#f6f2f5' }} content={<TooltipCard formatter={(v) => money(v)} />} />
        <Bar dataKey="net" name="Net salary" fill={SERIES.primary} radius={[0, 4, 4, 0]} barSize={18}>
          <LabelList dataKey="net" position="right" formatter={compactMoney}
            style={{ fontSize: 11, fill: '#1f2937', fontWeight: 500 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// Change over time, one series: 2px line, 8px markers, crosshair tooltip.
export function NetSalaryTrend({ data }) {
  return (
    <ResponsiveContainer width="100%" height={230}>
      <LineChart data={data} margin={{ top: 16, right: 20, bottom: 4, left: 4 }}>
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
export function AttendanceComposition({ overview }) {
  const parts = [
    { key: 'present', label: 'Present', value: overview.present, color: STATUS.good },
    { key: 'late', label: 'Late', value: overview.late, color: STATUS.warning },
    { key: 'absent', label: 'Absent / No check-out', value: overview.absent + overview.missingCheckout, color: STATUS.critical },
  ];
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;

  return (
    <div>
      {/* 2px surface gaps between segments, per the mark spec */}
      <div className="flex h-6 gap-0.5 overflow-hidden rounded">
        {parts.map((p) => (
          <div
            key={p.key}
            title={`${p.label}: ${p.value}`}
            style={{ width: `${(p.value / total) * 100}%`, background: p.color }}
            className="first:rounded-l last:rounded-r"
          />
        ))}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {parts.map((p) => (
          <div key={p.key} className="flex items-baseline gap-2">
            <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: p.color }} />
            <span>
              <span className="block text-base font-semibold leading-tight text-ink">
                {p.value}
                <span className="ml-1 text-xs font-normal text-ink-soft">
                  {((p.value / total) * 100).toFixed(0)}%
                </span>
              </span>
              <span className="block text-xs text-ink-soft">{p.label}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Leave types are user-configurable colours, so the bar carries one hue and the
// type's own colour appears only as a swatch beside its name.
export function LeaveBreakdown({ data }) {
  const max = Math.max(1, ...data.map((d) => d.days));
  return (
    <div className="grid gap-2.5">
      {data.map((d) => (
        <div key={d.name}>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 text-ink">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: d.color }} />
              {d.name}
            </span>
            <span className="font-medium tabular-nums text-ink">{d.days} days</span>
          </div>
          <div className="h-2 overflow-hidden rounded bg-gray-100">
            <div className="h-full rounded" style={{ width: `${(d.days / max) * 100}%`, background: SERIES.primary }} />
          </div>
        </div>
      ))}
    </div>
  );
}
