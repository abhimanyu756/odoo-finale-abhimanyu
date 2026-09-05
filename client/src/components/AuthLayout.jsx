// Shared chrome for the signed-out screens so login, forgot and reset match.
export default function AuthLayout({ children }) {
  return (
    <div className="relative grid min-h-screen place-items-center bg-gradient-to-br from-odoo-50 via-canvas to-teal-soft/40 px-4 py-8">
      {/* Event mark in the corner: it identifies the occasion, not the product,
          so it sits outside the card rather than competing with the name in it. */}
      <div className="absolute left-4 top-4 flex items-center gap-2 sm:left-6 sm:top-5">
        <span className="grid h-7 w-7 place-items-center rounded-md bg-odoo-500 text-[11px] font-bold text-white">
          O
        </span>
        <span className="leading-none">
          <span className="block text-sm font-semibold tracking-tight text-ink">Odoo</span>
          <span className="mt-0.5 block text-[9px] font-medium uppercase tracking-[0.14em] text-odoo-500">
            Hackathon 2026
          </span>
        </span>
      </div>

      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-odoo-500 text-sm font-bold text-white">
            PP
          </span>
          <h1 className="text-xl font-semibold text-ink">PeoplePay360</h1>
          <p className="text-sm text-ink-soft">HR &amp; Payroll Operations</p>
        </div>
        {children}
      </div>
    </div>
  );
}
