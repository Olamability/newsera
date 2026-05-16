export default function Sources() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-4">Sources</h1>
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        The <code>sources</code> table is not present in the current database schema snapshot.
        Source-management workflows are deprecated until the schema explicitly restores this table.
      </div>
    </div>
  )
}
