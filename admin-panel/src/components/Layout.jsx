import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

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

  async function handleSignOut() {
    await signOut()
    navigate('/login')
  }

  return (
    <div className="flex h-screen bg-gray-100">
      {/* Sidebar */}
      <aside className="w-64 bg-gray-900 text-white flex flex-col">
        <div className="px-6 py-5 border-b border-gray-700">
          <span className="text-xl font-bold tracking-wide">Newsera Admin</span>
        </div>
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
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${isActive
                    ? 'bg-indigo-600 text-white'
                    : 'text-gray-300 hover:bg-gray-700 hover:text-white'
                  }`
                }
              >
                <span>{icon}</span>
                {label}
              </NavLink>
            </div>
          ))}
        </nav>
        <div className="px-4 py-4 border-t border-gray-700">
          <button
            onClick={handleSignOut}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-gray-300 hover:bg-gray-700 hover:text-white transition-colors"
          >
            <span>🚪</span> Sign Out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto p-8">
        {children}
      </main>
    </div>
  )
}
