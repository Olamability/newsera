export default function PublisherApplication() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-2">Publisher Application</h1>
      <p className="text-sm text-gray-500 mb-4">
        Publisher onboarding is currently unavailable.
      </p>
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        This feature depends on the <code>sources</code> table, which is not part of the active schema snapshot.
        It is now marked deprecated to keep admin behavior aligned with the database source of truth.
      </div>
    </div>
  )
}
