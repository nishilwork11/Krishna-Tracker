/** Small labelled number tile used in the activity summary row. */
export default function StatCard({ label, value, tone }: { label: string; value: string; tone?: string }): React.JSX.Element {
  return (
    <div className="card stat">
      <div className="stat-label">
        {tone && <i className={`sw ${tone}`} aria-hidden />}
        {label}
      </div>
      <div className="stat-value">{value}</div>
    </div>
  )
}
