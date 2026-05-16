import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function CategoryModal({ category, onClose, onSaved }) {
  const isEdit = !!category
  const [name, setName] = useState(category?.name ?? '')
  const [slug, setSlug] = useState(category?.slug ?? '')
  const [autoSlug, setAutoSlug] = useState(!isEdit)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function handleNameChange(e) {
    setName(e.target.value)
    if (autoSlug) setSlug(slugify(e.target.value))
  }

  function handleSlugChange(e) {
    setSlug(e.target.value)
    setAutoSlug(false)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')

    const payload = { name: name.trim(), slug: slug.trim() }
    const { error } = isEdit
      ? await supabase.from('categories').update(payload).eq('id', category.id)
      : await supabase.from('categories').insert(payload)

    setSaving(false)
    if (error) { setError(error.message); return }
    onSaved()
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">
          {isEdit ? 'Edit Category' : 'New Category'}
        </h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              value={name}
              onChange={handleNameChange}
              required
              placeholder="e.g. Technology"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Slug</label>
            <input
              value={slug}
              onChange={handleSlugChange}
              required
              placeholder="e.g. technology"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={saving}
              className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors disabled:opacity-50 text-sm">
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create'}
            </button>
            <button type="button" onClick={onClose}
              className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-2 px-4 rounded-lg transition-colors text-sm">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function Categories() {
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [modalTarget, setModalTarget] = useState(undefined) // undefined=closed, null=new, obj=edit

  async function loadCategories() {
    setLoading(true)
    const { data, error } = await supabase.from('categories').select('*').order('name')
    setLoading(false)
    if (error) { setError(error.message); return }
    setCategories(data)
  }

  useEffect(() => { loadCategories() }, [])

  async function deleteCategory(id) {
    if (!confirm('Delete this category? Sources linked to it will have their category cleared.')) return
    const { error } = await supabase.from('categories').delete().eq('id', id)
    if (error) { setError(error.message); return }
    setCategories(prev => prev.filter(c => c.id !== id))
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-800">Categories</h1>
        <button
          onClick={() => setModalTarget(null)}
          className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
        >
          + New Category
        </button>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-gray-500">Loading categories…</p>
      ) : (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 uppercase text-xs tracking-wide">
              <tr>
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left">Slug</th>
                <th className="px-4 py-3 text-left">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {categories.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-gray-400">No categories yet.</td>
                </tr>
              )}
              {categories.map(cat => (
                <tr key={cat.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-800">{cat.name}</td>
                  <td className="px-4 py-3 text-gray-500 font-mono text-xs">{cat.slug}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setModalTarget(cat)}
                        className="text-xs bg-indigo-100 hover:bg-indigo-200 text-indigo-800 font-medium px-2 py-1 rounded-lg transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => deleteCategory(cat.id)}
                        className="text-xs bg-red-100 hover:bg-red-200 text-red-800 font-medium px-2 py-1 rounded-lg transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalTarget !== undefined && (
        <CategoryModal
          category={modalTarget}
          onClose={() => setModalTarget(undefined)}
          onSaved={() => { setModalTarget(undefined); loadCategories() }}
        />
      )}
    </div>
  )
}
