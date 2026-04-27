import { useEffect, useState } from 'react'
import { supabase } from '../services/supabase'

const STATUS_BADGE = {
  pending: 'bg-yellow-100 text-yellow-800',
  active: 'bg-green-100 text-green-800',
  inactive: 'bg-red-100 text-red-800',
}

function EditModal({ source, categories, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: source.name ?? '',
    website_url: source.website_url ?? '',
    rss_url: source.rss_url ?? '',
    category_id: source.category_id ?? '',
    status: source.status ?? 'pending',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function handleChange(e) {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { error } = await supabase
      .from('sources')
      .update({
        name: form.name,
        website_url: form.website_url,
        rss_url: form.rss_url,
        category_id: form.category_id || null,
        status: form.status,
      })
      .eq('id', source.id)
    setSaving(false)
    if (error) {
      if (error.code === '23505') {
        setError('This RSS feed is already registered.')
      } else {
        setError(error.message)
      }
      return
    }
    onSaved()
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">Edit Source</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input name="name" value={form.name} onChange={handleChange} required
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Website URL</label>
            <input name="website_url" value={form.website_url} onChange={handleChange}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">RSS URL</label>
            <input name="rss_url" value={form.rss_url} onChange={handleChange}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
            <select name="category_id" value={form.category_id} onChange={handleChange}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
              <option value="">— None —</option>
              {categories.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
            <select name="status" value={form.status} onChange={handleChange}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
              <option value="pending">Pending</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={saving}
              className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors disabled:opacity-50 text-sm">
              {saving ? 'Saving…' : 'Save Changes'}
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

export default function Sources() {
  const [sources, setSources] = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editTarget, setEditTarget] = useState(null)

  async function loadData() {
    setLoading(true)
    const [sourcesRes, catsRes] = await Promise.all([
      supabase.from('sources').select('*, categories(name)').order('created_at', { ascending: false }),
      supabase.from('categories').select('id, name').order('name'),
    ])
    setLoading(false)
    if (sourcesRes.error) { setError(sourcesRes.error.message); return }
    if (catsRes.error) { setError(catsRes.error.message); return }
    setSources(sourcesRes.data)
    setCategories(catsRes.data)
  }

  useEffect(() => { loadData() }, [])

  async function updateStatus(id, status) {
    const { error } = await supabase.from('sources').update({ status }).eq('id', id)
    if (error) { setError(error.message); return }
    setSources(prev => prev.map(s => s.id === id ? { ...s, status } : s))
  }

  async function deleteSource(id) {
    if (!confirm('Delete this source?')) return
    const { error } = await supabase.from('sources').delete().eq('id', id)
    if (error) { setError(error.message); return }
    setSources(prev => prev.filter(s => s.id !== id))
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-6">Sources</h1>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-gray-500">Loading sources…</p>
      ) : (
        <div className="overflow-x-auto bg-white rounded-2xl shadow-sm border border-gray-200">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 uppercase text-xs tracking-wide">
              <tr>
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left">Website</th>
                <th className="px-4 py-3 text-left">RSS URL</th>
                <th className="px-4 py-3 text-left">Category</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sources.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-gray-400">No sources found.</td>
                </tr>
              )}
              {sources.map(source => (
                <tr key={source.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-800">{source.name}</td>
                  <td className="px-4 py-3">
                    {source.website_url
                      ? <a href={source.website_url} target="_blank" rel="noreferrer"
                          className="text-indigo-600 hover:underline truncate max-w-[160px] block">
                          {source.website_url}
                        </a>
                      : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {source.rss_url
                      ? <a href={source.rss_url} target="_blank" rel="noreferrer"
                          className="text-indigo-600 hover:underline truncate max-w-[160px] block">
                          {source.rss_url}
                        </a>
                      : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{source.categories?.name ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_BADGE[source.status]}`}>
                      {source.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      {source.status !== 'active' && (
                        <button onClick={() => updateStatus(source.id, 'active')}
                          className="text-xs bg-green-100 hover:bg-green-200 text-green-800 font-medium px-2 py-1 rounded-lg transition-colors">
                          Approve
                        </button>
                      )}
                      {source.status !== 'inactive' && (
                        <button onClick={() => updateStatus(source.id, 'inactive')}
                          className="text-xs bg-red-100 hover:bg-red-200 text-red-800 font-medium px-2 py-1 rounded-lg transition-colors">
                          Reject
                        </button>
                      )}
                      <button onClick={() => setEditTarget(source)}
                        className="text-xs bg-indigo-100 hover:bg-indigo-200 text-indigo-800 font-medium px-2 py-1 rounded-lg transition-colors">
                        Edit
                      </button>
                      <button onClick={() => deleteSource(source.id)}
                        className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium px-2 py-1 rounded-lg transition-colors">
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

      {editTarget && (
        <EditModal
          source={editTarget}
          categories={categories}
          onClose={() => setEditTarget(null)}
          onSaved={() => { setEditTarget(null); loadData() }}
        />
      )}
    </div>
  )
}
