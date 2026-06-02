import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useState } from 'react'

const navItems = [
  { to: '/', label: 'Dashboard', icon: '🏠' },
  { to: '/sources', label: 'Sources', icon: '📰' },
  { to: '/publisher-application', label: 'Publisher Application', icon: '📝' },
  { to: '/categories', label: 'Categories', icon: '🗂️' },
  { to: '/analytics', label: 'Analytics', icon: '📊' },
  { to: '/infrastructure', label: 'Infrastructure', icon: '⚙️' },
  { to: '/moderation', label: 'Moderation', icon: '🛡️', section: 'Trust & Safety' },
  { to: '/moderation/reports', label: 'Reports queue', icon: '📨' },
  { to: '/moderation/users', label: 'Users / suspensions', icon: '👤' },
  { to: '/moderation/verifications', label: 'Verifications', icon: '🪪' },
  { to: '/moderation/fraud', label: 'Fraud monitor', icon: '🚨' },
  { to: '/moderation/analytics', label: 'Mod analytics', icon: '📈' },
  { to: '/moderation/audit', label: 'Audit log', icon: '📜' },
]

export default function Layout({ children }) {
  const { signOut } = useAuth()
  const navigate = useNavigate()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  async function handleSignOut() {
    await signOut()
    navigate('/login')
  }

  function closeMobileMenu() {
    setMobileMenuOpen(false)
  }

  return (
    <div className="flex h-screen bg-gray-100">
      {/* Mobile menu overlay */}
      {mobileMenuOpen && (
        <div 
          className="fixed inset-0 bg-black bg-opacity-50 z-40 lg:hidden"
          onClick={closeMobileMenu}
        />
      )}

      {/* Sidebar */}
      <aside className={`
        fixed lg:static inset-y-0 left-0 z-50
        w-64 bg-gray-900 text-white flex flex-col
        transform transition-transform duration-300 ease-in-out
        ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
      `}>
        {/* Header with close button on mobile */}
        <div className="px-6 py-5 border-b border-gray-700 flex items-center justify-between">
          <span className="text-xl font-bold tracking-wide">Newsera Admin</span>
          <button
            onClick={closeMobileMenu}
            className="lg:hidden text-gray-400 hover:text-white"
            aria-label="Close menu"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-4 py-6 space-y-1 overflow-y-auto">
          {navItems.map(({ to, label, icon, section }) => (
            <div key={to}>
              {section && (
                <p className="px-3 mt-4 mb-1 text-[10px] uppercase tracking-wider text-gray-500">
                  {section}
                </p>
              )}
              <NavLink
                to={to}
                end={to === '/' || to === '/moderation'}
                onClick={closeMobileMenu}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${isActive
                    ? 'bg-indigo-600 text-white'
                    : 'text-gray-300 hover:bg-gray-700 hover:text-white'
                  }`
                }
              >
                <span>{icon}</span>
                <span className="truncate">{label}</span>
              </NavLink>
            </div>
          ))}
        </nav>

        {/* Sign out button */}
        <div className="px-4 py-4 border-t border-gray-700">
          <button
            onClick={handleSignOut}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-gray-300 hover:bg-gray-700 hover:text-white transition-colors"
          >
            <span>🚪</span> <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile header */}
        <header className="lg:hidden bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
          <button
            onClick={() => setMobileMenuOpen(true)}
            className="text-gray-600 hover:text-gray-900"
            aria-label="Open menu"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="text-lg font-bold text-gray-800">Newsera Admin</span>
          <div className="w-6" /> {/* Spacer for centering */}
        </header>

        {/* Main scrollable content */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  )
}
