# Quick Test Guide: Reactions & Registration Fixes

## 🚀 Pre-Deployment

### 1. Apply Database Migration
```bash
cd supabase
supabase db push
```

Or in Supabase Dashboard SQL Editor:
```sql
-- Paste and run contents of:
-- migrations/064_fix_article_reactions_rls.sql
```

Verify:
```sql
SELECT policyname FROM pg_policies 
WHERE tablename = 'article_reactions';
```
Should return 4 policies.

---

## ✅ Testing Reactions (5 minutes)

### Test 1: Guest User (Not Logged In)
1. Open app without logging in
2. Open any article
3. Tap like button (👍)
4. **Expected:** "Sign in required" alert
5. **Pass if:** No crash, alert appears

### Test 2: Authenticated User - Like
1. Login to app
2. Open any article
3. Tap like button (👍)
4. **Expected:**
   - Button fills/highlights immediately
   - Count increases by 1
   - No error message
5. **Pass if:** All three conditions met

### Test 3: Toggle Off (Unlike)
1. With same article liked
2. Tap like button again
3. **Expected:**
   - Button returns to normal
   - Count decreases by 1
   - No error
4. **Pass if:** Toggle works smoothly

### Test 4: Dislike
1. Tap dislike button (👎)
2. **Expected:**
   - Dislike activates
   - If article was liked, like deactivates
   - Counts update correctly
3. **Pass if:** Mutually exclusive reactions work

### Test 5: Network Error
1. Enable airplane mode
2. Try to react
3. **Expected:** Clear error message
4. Re-enable network
5. Try again
6. **Expected:** Works after network restored

---

## ✅ Testing Registration (5 minutes)

### Test 1: Valid Registration
1. Tap "Register" from login
2. Enter:
   - Email: test@example.com
   - Password: password123
   - Confirm: password123
3. Tap "Create Account"
4. **Expected:**
   - Either logged in immediately, OR
   - Alert: "Check your email to confirm"
5. **Pass if:** No generic error, clear outcome

### Test 2: Password Validation
1. Try password: "pass" (< 6 chars)
2. **Expected:** "Password must be at least 6 characters"
3. **Pass if:** Validation works before API call

### Test 3: Password Mismatch
1. Enter password: "password123"
2. Enter confirm: "password456"
3. **Expected:** "Passwords do not match"
4. **Pass if:** Caught before API call

### Test 4: Duplicate Email
1. Register with email that already exists
2. **Expected:** 
   - "User already registered" or
   - "Email already in use"
3. **Pass if:** Clear error message (not generic failure)

### Test 5: Email Confirmation Flow
*Only if email confirmation is enabled*

1. Register new account
2. **Expected:** "Check your email to confirm"
3. Check test email
4. Click confirmation link
5. Return to app
6. Login with credentials
7. **Expected:** Successfully logged in
8. **Pass if:** Full flow works

---

## 🐛 Debug Mode Testing

### Enable Debug Logs

**iOS:**
```bash
npx react-native log-ios | grep -E "\[ArticleReaction\]|\[Auth\]|\[Register\]"
```

**Android:**
```bash
npx react-native log-android | grep -E "\[ArticleReaction\]|\[Auth\]|\[Register\]"
```

### What to Look For

**Good Logs (Success):**
```
[ArticleReaction] Insert successful
[Auth] Sign up successful
[Register] Auto-login successful
```

**Bad Logs (Errors to Fix):**
```
[ArticleReaction] Insert error: permission denied
[ArticleReaction] RLS policy violation
[Auth] Sign up error: rate limit exceeded
[Register] Registration error: network request failed
```

---

## 🔍 Database Verification

### Check Reactions Are Saving
```sql
-- Should show recent reactions
SELECT 
  ar.id,
  ar.reaction_type,
  ar.created_at,
  a.title as article_title,
  u.email as user_email
FROM article_reactions ar
JOIN articles a ON a.id = ar.article_id
JOIN auth.users u ON u.id = ar.user_id
ORDER BY ar.created_at DESC
LIMIT 10;
```

### Check RPC Function Works
```sql
-- Pick any article ID from your database
SELECT * FROM get_article_reaction_counts(
  '12345678-1234-1234-1234-123456789abc'
);

-- Should return:
-- reaction_type | reaction_count
-- like          | 5
-- dislike       | 2
```

### Check New Users Are Created
```sql
-- Should show users registered in last hour
SELECT 
  id, 
  email, 
  created_at,
  confirmed_at
FROM auth.users
WHERE created_at > now() - interval '1 hour'
ORDER BY created_at DESC;
```

---

## 📊 Pass/Fail Criteria

### Reactions: PASS if 5/5 tests pass
- [ ] Guest user sees sign-in prompt
- [ ] Can like article
- [ ] Can toggle unlike
- [ ] Can dislike article (mutually exclusive)
- [ ] Network errors handled gracefully

### Registration: PASS if 5/5 tests pass
- [ ] Valid registration works
- [ ] Password < 6 chars rejected
- [ ] Password mismatch caught
- [ ] Duplicate email handled
- [ ] Email confirmation flow works (if enabled)

### Database: PASS if all queries return data
- [ ] Reactions query returns rows
- [ ] RPC function returns counts
- [ ] New users query shows registrations

---

## 🚨 Common Failures & Fixes

### ❌ Reactions still fail with "permission denied"

**Cause:** RLS policies not applied

**Fix:**
```sql
-- Re-run migration 064
\i migrations/064_fix_article_reactions_rls.sql
```

### ❌ Registration shows generic "failed" error

**Cause:** Error not being logged

**Fix:**
1. Check console logs (should see specific error)
2. Common causes:
   - Rate limiting (wait 60 seconds, try again)
   - Invalid email format
   - Network connectivity

### ❌ Email confirmation emails not sent

**Cause:** SMTP not configured in Supabase

**Fix:**
1. Supabase Dashboard → Settings → Auth
2. Configure SMTP settings, OR
3. Disable email confirmation for testing

### ❌ RPC function returns no data

**Cause:** No reactions in database yet

**Fix:**
1. Like an article to create test data
2. Run query again

---

## 📝 Test Results Template

```
=== REACTION TESTS ===
[ ] Guest user sign-in prompt
[ ] Like article
[ ] Toggle unlike  
[ ] Dislike article
[ ] Network error handling

=== REGISTRATION TESTS ===
[ ] Valid registration
[ ] Password validation
[ ] Password mismatch
[ ] Duplicate email
[ ] Email confirmation (if enabled)

=== DATABASE VERIFICATION ===
[ ] Reactions saving correctly
[ ] RPC function works
[ ] Users being created

=== OVERALL ===
Reactions: ____ / 5 tests passed
Registration: ____ / 5 tests passed
Database: ____ / 3 checks passed

Status: [ ] PASS  [ ] FAIL

Issues found:
1. 
2. 
3. 

Date: _______________
Tester: _______________
```

---

## ✅ Success Criteria

**Production Ready if:**
- All reaction tests pass (5/5)
- All registration tests pass (5/5) 
- Database verification passes (3/3)
- No RLS errors in logs
- No generic error messages shown to users
- Debug logs show specific errors (in dev mode)

**Deploy when:**
- Test results show 13/13 passed
- No critical errors in logs
- Users get clear feedback on all actions

🎉 **Good luck with testing!**
