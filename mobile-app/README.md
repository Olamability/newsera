# NewsEra Mobile App

React Native Expo news aggregator connected to Supabase.

## Setup

1. Install dependencies:
   ```bash
   cd mobile-app
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your Supabase credentials:
   ```bash
   cp .env.example .env
   ```

3. Start the app:
   ```bash
   npx expo start
   ```

## Architecture

- **App.tsx** – Entry point, sets up navigation and providers
- **screens/HomeScreen.tsx** – Article feed with category filter and infinite scroll
- **screens/ArticleDetailScreen.tsx** – Full article detail view
- **components/ArticleCard.tsx** – Card component for article list
- **components/CategoryFilter.tsx** – Horizontal scrollable category tabs
- **services/supabase.ts** – Supabase client instance
- **services/newsService.ts** – API functions for fetching news and categories
- **types/index.ts** – Shared TypeScript types
- **context/CategoryContext.tsx** – Category selection context

## Environment Variables

| Variable | Description |
|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Your Supabase anonymous key |
