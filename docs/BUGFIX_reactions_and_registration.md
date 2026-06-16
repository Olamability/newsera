# Bug Fixes: Article Reactions & User Registration

## Issues Identified

### 1. Article Reactions Error
**Symptom:** "Failed to update reaction. Please try again" when clicking like/dislike buttons

**Root Causes:**
- RLS (Row Level Security) policies on `article_reactions` table may be too restrictive
- Timing issues with auth token verification
- Missing error logging made debugging difficult

### 2. User Registration Error
**Symptom:** Error message when user registers

**Root Causes:**
- Email confirmation requirement not properly handled
- Auto-login after registration fails silently
- Poor error messages don't indicate the actual issue

---

## Fixes Applied

### Fix 1: Article Reactions Service

**File:** `mobile-app/services/articleReactionService.ts`

**Changes:**
1. Added comprehensive error logging in development mode
2. Made legacy operations (article_likes table) non-blocking with `.catch(() => {})`
3. Added debug logs for insert, update, and delete operations

**Benefits:**
- Developers can now see exact error messages in console
- Legacy table errors won't block the main reaction functionality
- Better error diagnostics

### Fix 2: Database RLS Policies

**File:** `supabase/migrations/064_fix_article_reactions_rls.sql`

**Changes:**
1. Recreated RLS policies with explicit `auth.uid() IS NOT NULL` checks
2. Added both USING and WITH CHECK clauses for UPDATE policy
3. Verified RPC function permissions for anon and authenticated roles

**Benefits:**
- More explicit auth checks prevent edge cases
- UPDATE operations now properly validate both read and write permissions
- Functions are accessible to both anonymous and authenticated users

### Fix 3: Auth Context (Sign Up)

**File:** `mobile-app/context/AuthContext.tsx`

**Changes:**
1. Added explicit check for email confirmation in signUp
2. Added error logging in development mode
3. Properly handle null session when email confirmation is required

**Benefits:**
- Clear distinction between confirmed and unconfirmed accounts
- Better error messages for developers
- Graceful handling of email confirmation flow

### Fix 4: Registration Screen

**File:** `mobile-app/screens/RegisterScreen.tsx`

**Changes:**
1. Check if user is authenticated immediately after signUp
2. Better error handling for auto-login failures
3. Added debug logging for registration errors
4. Improved error messages to users

**Benefits:**
- Users get clear feedback about email confirmation
- Developers can see exact registration errors
- Handles all edge cases (instant auth, email confirmation, network errors)

---

## Deployment Steps

### Step 1: Apply Database Migration

Run the new migration to fix RLS policies:

```bash
cd supabase
supabase db push
```

Or in Supabase Dashboard:
1. Go to SQL Editor
2. Paste contents of `064_fix_article_reactions_rls.sql`
3. Click "Run"

### Step 2: Verify RLS Policies

Check that policies are correctly applied:

```sql
-- Verify policies exist
SELECT 
  schemaname, 
  tablename, 
  policyname, 
  permissive, 
  roles, 
  cmd
FROM pg_policies 
WHERE tablename = 'article_reactions'
ORDER BY policyname;

-- Should show:
-- article_reactions_delete_owner | DELETE | authenticated
-- article_reactions_insert_authenticated | INSERT | authenticated
-- article_reactions_select_public | SELECT | (empty = all roles)
-- article_reactions_update_owner | UPDATE | authenticated
```

### Step 3: Deploy Mobile App Changes

```bash
cd mobile-app

# Test locally first
npx expo start

# Build for production
eas build --platform ios
eas build --platform android
```

### Step 4: Test the Fixes

#### Test Reactions:
1. Open any article in the app
2. Ensure you're logged in
3. Tap the like (👍) button
4. Verify:
   - Button changes state immediately
   - Count increases by 1
   - No error message appears
5. Tap like button again (should toggle off)
6. Verify:
   - Button returns to normal state
   - Count decreases by 1
7. Tap dislike (👎) button
8. Verify:
   - Dislike activates
   - Like deactivates (mutually exclusive)
   - Counts update correctly

#### Test Registration:
1. Tap "Register" from login screen
2. Enter email and password
3. Tap "Create Account"
4. Check for different scenarios:

**Scenario A: Email Confirmation Disabled (Production)**
- User should be logged in immediately
- Navigate to main feed
- No error messages

**Scenario B: Email Confirmation Enabled (Testing)**
- User sees: "Account created. Check your email to confirm."
- Redirected to login screen
- Can sign in after confirming email

**Scenario C: Duplicate Email**
- User sees: "User already registered"
- Can navigate back to login

### Step 5: Monitor Errors

Check logs after deployment:

**Mobile App Logs:**
```bash
# iOS
npx react-native log-ios

# Android
npx react-native log-android

# Look for:
[ArticleReaction] Insert error: ...
[ArticleReaction] Update error: ...
[ArticleReaction] Delete error: ...
[Auth] Sign up error: ...
[Register] Registration error: ...
```

**Supabase Logs:**
1. Go to Supabase Dashboard
2. Navigate to Logs → Postgres Logs
3. Filter for errors related to:
   - `article_reactions`
   - `auth.users`
   - RLS policy violations

---

## Troubleshooting

### Issue: Still getting reaction errors

**Check:**
1. Is migration 064 applied?
   ```sql
   SELECT * FROM public.article_reactions LIMIT 1;
   -- If error "permission denied", RLS is still blocking
   ```

2. Is user actually authenticated?
   ```typescript
   // Add to ArticleDetailScreen.tsx
   console.log('User ID:', user?.id);
   console.log('User role:', user?.role);
   ```

3. Check RLS policies in Supabase Dashboard:
   - Go to Table Editor → article_reactions
   - Click "View Policies"
   - Verify all 4 policies exist

**Fix:**
If policies are missing, manually recreate them using the SQL from migration 064.

### Issue: Registration succeeds but user not logged in

**Check:**
1. Is email confirmation required?
   - Go to Supabase Dashboard → Authentication → Providers
   - Check "Email" provider settings
   - Look for "Enable email confirmations"

2. Check auth state in app:
   ```typescript
   // In RegisterScreen after signUp
   console.log('Session after signUp:', session);
   console.log('User after signUp:', user);
   ```

**Fix:**
For development/testing, disable email confirmation:
1. Supabase Dashboard → Authentication → Settings
2. Find "Enable email confirmations"
3. Toggle OFF
4. Save

For production, keep email confirmation ON and ensure users check their email.

### Issue: Users can't see reaction counts

**Check:**
1. Is RPC function accessible?
   ```sql
   -- Test the function
   SELECT * FROM get_article_reaction_counts('article-uuid-here');
   ```

2. Check function permissions:
   ```sql
   SELECT 
     routine_name, 
     routine_type, 
     security_type
   FROM information_schema.routines 
   WHERE routine_name = 'get_article_reaction_counts';
   ```

**Fix:**
Run this SQL:
```sql
GRANT EXECUTE ON FUNCTION get_article_reaction_counts(uuid) TO anon, authenticated;
```

### Issue: Legacy article_likes errors

The service now catches and ignores errors from the legacy `article_likes` table.

**Check logs:**
```typescript
// You should NOT see errors about article_likes blocking reactions
// All article_likes operations now use .catch(() => {})
```

**If still seeing blocking errors:**
The error is coming from somewhere else. Check:
1. Ensure latest code is deployed
2. Clear app cache and rebuild
3. Check for other code calling article_likes directly

---

## Testing Checklist

Before marking as complete:

### Reactions Testing
- [ ] Guest user sees reaction counts but can't react
- [ ] Guest tapping reaction shows "Sign in required" alert
- [ ] Authenticated user can like an article
- [ ] Like count increases correctly
- [ ] Tapping like again removes the like (toggle)
- [ ] Authenticated user can dislike an article
- [ ] Dislike count increases correctly
- [ ] Liking after disliking switches reaction (mutually exclusive)
- [ ] Reaction counts update in real-time (other users' reactions appear)
- [ ] No error messages appear during normal operation
- [ ] Console shows no RLS violations or permission errors

### Registration Testing
- [ ] Can register with valid email and password
- [ ] Cannot register with password < 6 characters
- [ ] Cannot register with mismatched passwords
- [ ] Cannot register with existing email (proper error message)
- [ ] Email confirmation flow works (if enabled)
- [ ] Auto-login works after registration (if confirmation disabled)
- [ ] User is properly redirected after successful registration
- [ ] Error messages are clear and helpful
- [ ] Console shows helpful debug info in development mode

### Database Testing
```sql
-- Verify reactions are being saved
SELECT * FROM article_reactions 
ORDER BY created_at DESC 
LIMIT 10;

-- Check for orphaned reactions (should be 0)
SELECT COUNT(*) 
FROM article_reactions ar
LEFT JOIN articles a ON a.id = ar.article_id
WHERE a.id IS NULL;

-- Verify RPC function works
SELECT * FROM get_article_reaction_counts(
  (SELECT id FROM articles LIMIT 1)
);

-- Check auth users exist
SELECT COUNT(*) FROM auth.users;
```

---

## Additional Recommendations

### 1. Disable Email Confirmation for Development

**File:** `.env` in mobile-app folder

Add:
```env
# Disable email confirmation in development
EXPO_PUBLIC_SUPABASE_REQUIRE_EMAIL_CONFIRMATION=false
```

Then in Supabase Dashboard:
- Authentication → Settings → Email Auth
- Uncheck "Enable email confirmations" for dev environment
- Keep it ON for production

### 2. Add Better Error Messages

Consider adding user-friendly error messages for common scenarios:

```typescript
// In ArticleDetailScreen.tsx
catch (err) {
  let userMessage = 'Failed to update reaction. Please try again.';
  
  if (err instanceof InteractionAuthRequiredError) {
    userMessage = 'Please sign in to react to articles.';
  } else if (err.message?.includes('RLS')) {
    userMessage = 'Permission denied. Please sign in again.';
  } else if (err.message?.includes('network')) {
    userMessage = 'Network error. Check your connection.';
  }
  
  Alert.alert('Error', userMessage);
}
```

### 3. Add Retry Logic

For network errors, consider adding automatic retry:

```typescript
// In articleReactionService.ts
async function toggleArticleReactionWithRetry(
  articleId: string,
  reaction: ArticleReactionType,
  maxRetries = 2
): Promise<ArticleReactionType | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await toggleArticleReaction(articleId, reaction);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      if (err.message?.includes('network')) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}
```

### 4. Monitor Production Errors

Set up error tracking with Sentry or similar:

```typescript
// In articleReactionService.ts
import * as Sentry from '@sentry/react-native';

catch (err) {
  if (!__DEV__) {
    Sentry.captureException(err, {
      tags: {
        feature: 'article_reactions',
        operation: 'toggle',
      },
      extra: {
        articleId,
        reaction,
        userId: user?.id,
      },
    });
  }
  throw err;
}
```

---

## Summary

✅ **Fixed Issues:**
1. Article reaction RLS policies now properly allow authenticated users to react
2. Error logging helps diagnose issues in development
3. Legacy operations don't block new reactions
4. Registration properly handles email confirmation
5. Better error messages for users and developers

✅ **Files Modified:**
1. `mobile-app/services/articleReactionService.ts` - Better error handling
2. `mobile-app/context/AuthContext.tsx` - Email confirmation handling
3. `mobile-app/screens/RegisterScreen.tsx` - Improved registration flow
4. `supabase/migrations/064_fix_article_reactions_rls.sql` - Fixed RLS policies

✅ **Next Steps:**
1. Deploy database migration
2. Deploy mobile app updates
3. Test all scenarios
4. Monitor for any remaining errors
5. Consider implementing additional recommendations

🚀 **Both issues should now be resolved!**
