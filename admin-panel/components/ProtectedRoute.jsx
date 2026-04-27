import { Navigate } from 'react-router-dom'
import { useAuth } from '../src/context/AuthContext'

export default function ProtectedRoute({ children }) {
  const { session, isAdmin, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-gray-500">Loading…</p>
      </div>
    )
  }

  if (!session) return <Navigate to="/login" replace />
  if (!isAdmin) return <Navigate to="/unauthorized" replace />

  return children
}
