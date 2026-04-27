# Newsera Admin Panel

React + Vite admin dashboard for the Newsera news aggregator platform.

## Tech Stack

- [React 18](https://react.dev/) + [Vite 5](https://vitejs.dev/)
- [React Router v6](https://reactrouter.com/)
- [Supabase JS v2](https://supabase.com/docs/reference/javascript)
- [Tailwind CSS v3](https://tailwindcss.com/)

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in your Supabase project credentials:

```bash
cp .env.example .env
```

Edit `.env`:

```
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here
VITE_ADMIN_EMAIL=admin@yourdomain.com
```

> `VITE_ADMIN_EMAIL` is the **only** email address that will be granted access to the dashboard. Any other authenticated user will see an "Access Denied" screen.

### 3. Start the dev server

```bash
npm run dev
```

### 4. Build for production

```bash
npm run build
```

## Features

| Page | Route | Description |
|------|-------|-------------|
| Login | `/login` | Admin sign-in via Supabase email/password auth |
| Dashboard | `/` | Stats: total / pending / active sources |
| Sources | `/sources` | Table of all sources with Approve / Reject / Edit / Delete actions |
| Publisher Application | `/publisher-application` | Form to submit a new source (saved with `status = pending`) |
| Categories | `/categories` | Create, edit, and delete news categories |

## Project Structure

```
admin-panel/
├── components/
│   ├── Layout.jsx          # Sidebar + main wrapper
│   └── ProtectedRoute.jsx  # Redirects non-admin users
├── pages/
│   ├── Login.jsx
│   ├── Dashboard.jsx
│   ├── Sources.jsx
│   ├── PublisherApplication.jsx
│   └── Categories.jsx
├── services/
│   └── supabase.js         # Supabase client singleton
└── src/
    ├── context/
    │   └── AuthContext.jsx  # Auth state + admin check
    ├── App.jsx              # Route definitions
    ├── main.jsx             # React entry point
    └── index.css            # Tailwind directives
```

## Supabase Notes

The dashboard relies on the schema defined in `../supabase/migrations/001_initial_schema.sql`.

For write operations (insert / update / delete on `sources` and `categories`) to work from the admin dashboard, you need to add RLS policies that allow authenticated admin users to mutate those tables. Example:

```sql
-- Allow authenticated users to insert/update/delete sources
CREATE POLICY "sources_admin_write" ON sources
  FOR ALL USING (auth.role() = 'authenticated');

-- Allow authenticated users to insert/update/delete categories  
CREATE POLICY "categories_admin_write" ON categories
  FOR ALL USING (auth.role() = 'authenticated');
```

Alternatively, you can use the Supabase service-role key (keep it server-side only) or implement a Supabase Edge Function for admin mutations.
