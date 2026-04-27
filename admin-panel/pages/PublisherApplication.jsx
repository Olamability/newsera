import { useEffect, useState } from 'react'
import { supabase } from '../services/supabase'

export default function PublisherApplication() {
  const [categories, setCategories] = useState([])
  const [form, setForm] = useState({
    name: '',
    website_url: '',
    rss_url: '',
    category_id: '',
    logo_url: '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    supabase
      .from('categories')
      .select('id, name')
      .order('name')
      .then(({ data, error }) => {
        if (!error) setCategories(data)
      })
  }, [])

  function handleChange(e) {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSuccess(false)
    setSubmitting(true)

    // Check rss_url uniqueness before insert
    const { data: existing, error: checkError } = await supabase
      .from('sources')
      .select('id')
      .eq('rss_url', form.rss_url)
      .maybeSingle()

    if (checkError) {
      setError(checkError.message)
      setSubmitting(false)
      return
    }

    if (existing) {
      setError('This RSS URL is already registered.')
      setSubmitting(false)
      return
    }

    const { error: insertError } = await supabase.from('sources').insert({
      name: form.name,
      website_url: form.website_url,
      rss_url: form.rss_url,
      category_id: form.category_id || null,
      logo_url: form.logo_url || null,
      status: 'pending',
    })

    setSubmitting(false)

    if (insertError) {
      setError(insertError.message)
      return
    }

    setSuccess(true)
    setForm({ name: '', website_url: '', rss_url: '', category_id: '', logo_url: '' })
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-2">Publisher Application</h1>
      <p className="text-sm text-gray-500 mb-6">
        Submit a new publisher source. It will be set to <strong>pending</strong> until reviewed.
      </p>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 max-w-lg">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Publisher Name <span className="text-red-500">*</span></label>
            <input
              name="name"
              value={form.name}
              onChange={handleChange}
              required
              placeholder="e.g. TechCrunch"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Website URL <span className="text-red-500">*</span></label>
            <input
              name="website_url"
              value={form.website_url}
              onChange={handleChange}
              type="url"
              required
              placeholder="https://example.com"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">RSS URL <span className="text-red-500">*</span></label>
            <input
              name="rss_url"
              value={form.rss_url}
              onChange={handleChange}
              type="url"
              required
              placeholder="https://example.com/feed.rss"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Category <span className="text-red-500">*</span></label>
            <select
              name="category_id"
              value={form.category_id}
              onChange={handleChange}
              required
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">— Select a category —</option>
              {categories.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Logo URL <span className="text-gray-400 font-normal">(optional)</span></label>
            <input
              name="logo_url"
              value={form.logo_url}
              onChange={handleChange}
              type="url"
              placeholder="https://example.com/logo.png"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          {success && (
            <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
              ✅ Application submitted for review.
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors disabled:opacity-50 text-sm"
          >
            {submitting ? 'Submitting…' : 'Submit Application'}
          </button>
        </form>
      </div>
    </div>
  )
}
