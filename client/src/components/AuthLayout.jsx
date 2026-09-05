// Shared chrome for the signed-out screens so login, forgot and reset match.
export default function AuthLayout({ children }) {
  return (
    <div className="grid min-h-screen place-items-center bg-gradient-to-br from-odoo-50 via-canvas to-teal-soft/40 px-4 py-8">
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
