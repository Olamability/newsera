# Publisher Traffic Distribution - Deployment Checklist

## Pre-Deployment Verification

### ✅ Database (Supabase)
- [ ] Migration 063 (`article_outbound_clicks`) has been applied
- [ ] Verify table exists:
  ```sql
  SELECT COUNT(*) FROM article_outbound_clicks;
  ```
- [ ] Verify view exists:
  ```sql
  SELECT * FROM publisher_traffic_summary LIMIT 1;
  ```
- [ ] Check RLS policies are active:
  ```sql
  SELECT tablename, policyname FROM pg_policies 
  WHERE tablename = 'article_outbound_clicks';
  ```
- [ ] Verify indexes exist:
  ```sql
  SELECT indexname FROM pg_indexes 
  WHERE tablename = 'article_outbound_clicks';
  ```

### ✅ Mobile App
- [ ] `outboundClickService.ts` exists and exports:
  - `openArticleUrl()`
  - `buildTrackedUrl()`
  - `buildShareTrackedUrl()`
- [ ] `ArticleDetailScreen.tsx` calls `openArticleUrl()` on "Read Full Article" button
- [ ] `shareService.ts` uses `buildShareTrackedUrl()` for publisher URLs
- [ ] Test on iOS simulator/device:
  - Opens SFSafariViewController
  - URL includes UTM params
  - Click is logged to database
- [ ] Test on Android emulator/device:
  - Opens Chrome Custom Tab
  - URL includes UTM params
  - Click is logged to database

### ✅ Admin Panel
- [ ] `PublisherTraffic.jsx` file exists in `src/pages/`
- [ ] Route added to `App.jsx`: `/publisher-traffic`
- [ ] Nav item added to `Layout.jsx`: "Publisher Traffic" 🚀
- [ ] Build succeeds:
  ```bash
  cd admin-panel
  npm run build
  ```
- [ ] Test locally:
  ```bash
  npm run dev
  ```
- [ ] Navigate to `/publisher-traffic` and verify:
  - Summary cards display
  - Table displays (even if empty)
  - No console errors

---

## Deployment Steps

### 1. Deploy Database Changes (if not done)
```bash
# If migration 063 hasn't been applied yet:
cd supabase
supabase db push
```

### 2. Deploy Mobile App
```bash
cd mobile-app

# Test build
npx expo start

# Submit to stores (when ready)
eas build --platform ios
eas build --platform android
```

### 3. Deploy Admin Panel
```bash
cd admin-panel

# Build production bundle
npm run build

# Deploy to Vercel (if using Vercel)
vercel --prod

# Or deploy to your hosting provider
```

---

## Post-Deployment Testing

### Step 1: Verify Database Connection
```sql
-- Run in Supabase SQL Editor
INSERT INTO article_outbound_clicks (
  article_id,
  source_id,
  device_id,
  utm_url
) VALUES (
  (SELECT id FROM articles LIMIT 1),
  (SELECT id FROM sources LIMIT 1),
  'test-device-12345',
  'https://example.com?utm_source=newsera'
);

-- Should insert successfully

-- Verify view updates
SELECT * FROM publisher_traffic_summary 
WHERE source_id = (SELECT id FROM sources LIMIT 1);
```

### Step 2: Test Mobile App Flow
1. Open NewsEra app on physical device
2. Browse to any article
3. Tap "Read Full Article"
4. **Verify:**
   - Browser opens within the app (not external)
   - URL bar shows publisher domain
   - UTM parameters visible in URL: `?utm_source=newsera&utm_medium=aggregator&utm_campaign=feed`
   - Article content loads properly
   - Ads display (if publisher has ads)

5. Check database:
```sql
SELECT * FROM article_outbound_clicks 
ORDER BY clicked_at DESC 
LIMIT 10;
```
Should show your test click.

### Step 3: Test Admin Dashboard
1. Login to admin panel
2. Navigate to "Publisher Traffic" in sidebar
3. **Verify:**
   - Summary cards show numbers > 0
   - Table lists at least one publisher
   - "This Month" column shows recent test clicks
   - "Last Click" shows timestamp of your test

### Step 4: Test User Sharing
1. In mobile app, open any article
2. Tap share button
3. Share to any platform (WhatsApp, Twitter, etc.)
4. **Verify shared message contains:**
   - Article title
   - Source name
   - App link: `newsera://article/{id}`
   - Publisher link with UTM: `?utm_source=newsera&utm_medium=share&utm_campaign=user_share`

5. Click the publisher link from share
6. Verify UTM params are present in browser

---

## Publisher Onboarding Checklist

Once deployed, use this to onboard publishers:

### 1. Send Traffic Report Email
```
Subject: NewsEra sent you [X] clicks this month

Hi [Publisher Name],

NewsEra distributed [X] clicks to your website this month!

You can verify this traffic in your Google Analytics 4:
1. Open GA4 dashboard
2. Go to: Acquisition → Traffic Acquisition
3. Look for source: "newsera"
4. Medium will show: "aggregator"

This traffic is:
✅ Real browser sessions (not bots)
✅ Fully attributed to NewsEra
✅ Generates ad revenue for you
✅ 100% free (no cost per click)

How it works:
• Users discover your articles in NewsEra app
• They read a snippet
• They click "Read Full Article"
• They land on YOUR website
• YOUR ads display
• YOU keep 100% revenue

Questions? Reply to this email.

Best regards,
NewsEra Team
```

### 2. GA4 Verification Template
Send to publishers who want to verify:

```
To verify NewsEra traffic in your Google Analytics 4:

Step 1: Login to GA4
  https://analytics.google.com/

Step 2: Select your property
  [Your Website]

Step 3: Navigate to reports
  Reports → Acquisition → Traffic Acquisition

Step 4: Look for these values
  Source: newsera
  Medium: aggregator (for feed clicks)
       OR share (for user shares)
  Campaign: feed OR user_share

Step 5: View metrics
  • Users from NewsEra
  • Sessions
  • Engagement rate
  • Pages per session
  • Revenue (if e-commerce is set up)

You can also create a custom segment:
  Source = "newsera" AND Medium = "aggregator"

This will isolate all NewsEra traffic for deeper analysis.
```

---

## Monitoring & Alerts

### Daily Checks (First 2 Weeks)
- [ ] Check total clicks today in admin dashboard
- [ ] Verify clicks are being logged:
  ```sql
  SELECT COUNT(*) FROM article_outbound_clicks 
  WHERE clicked_at >= CURRENT_DATE;
  ```
- [ ] Check for errors in mobile app logs (search: `[OutboundClick]`)
- [ ] Monitor Supabase logs for database errors

### Weekly Checks (Ongoing)
- [ ] Review publisher traffic summary
- [ ] Identify top 10 publishers by monthly clicks
- [ ] Check for any publishers with 0 clicks (content quality issue?)
- [ ] Verify UTM parameters are present in 100% of clicks:
  ```sql
  SELECT 
    COUNT(*) FILTER (WHERE utm_url LIKE '%utm_source=newsera%') * 100.0 / COUNT(*) as utm_rate
  FROM article_outbound_clicks;
  -- Should be 100% or very close
  ```

### Monthly Reports
- [ ] Generate publisher traffic report
- [ ] Email top 10 publishers with their stats
- [ ] Analyze trends (growing, shrinking, stable)
- [ ] Identify opportunities for publisher partnerships

---

## Rollback Plan (If Issues Occur)

### If Mobile App Has Issues
1. **Don't panic** - tracking failure never blocks article viewing
2. Check mobile app logs for errors
3. Verify Supabase is reachable
4. If critical bug: fall back to direct URL open without tracking
   ```typescript
   // Emergency fallback in outboundClickService.ts
   await Linking.openURL(article.url);
   ```

### If Admin Dashboard Has Issues
1. Admin dashboard is read-only - no risk to data
2. Check browser console for errors
3. Verify Supabase connection
4. Use direct SQL queries as temporary workaround:
   ```sql
   -- Manual query for publisher traffic
   SELECT 
     s.name,
     COUNT(*) as clicks_today,
     COUNT(*) FILTER (WHERE clicked_at >= date_trunc('month', now())) as clicks_month
   FROM article_outbound_clicks aoc
   JOIN sources s ON s.id = aoc.source_id
   WHERE clicked_at >= CURRENT_DATE
   GROUP BY s.name
   ORDER BY clicks_month DESC;
   ```

### If Database Has Issues
1. Migration 063 is safe - only adds tables/views, doesn't modify existing
2. If needed, rollback:
   ```sql
   DROP VIEW IF EXISTS publisher_traffic_summary;
   DROP TABLE IF EXISTS article_outbound_clicks;
   ```
3. Mobile app will fail tracking gracefully (user still sees articles)

---

## Success Criteria

After 1 week in production, you should see:

✅ **Mobile App:**
- [ ] >0 rows in `article_outbound_clicks` table
- [ ] No crashes related to outbound click tracking
- [ ] Users successfully opening publisher articles

✅ **Admin Dashboard:**
- [ ] Dashboard loads without errors
- [ ] At least 1 publisher showing traffic
- [ ] Summary cards showing counts > 0

✅ **Publisher Feedback:**
- [ ] At least 1 publisher confirms seeing NewsEra traffic in their GA4
- [ ] UTM parameters correctly formatted
- [ ] No complaints about broken links or tracking

---

## Documentation Links

After deployment, share these with your team:

1. **For Developers:**
   - [PUBLISHER_TRAFFIC_IMPLEMENTATION.md](./PUBLISHER_TRAFFIC_IMPLEMENTATION.md)
   - [TRAFFIC_ATTRIBUTION_ARCHITECTURE.txt](./TRAFFIC_ATTRIBUTION_ARCHITECTURE.txt)

2. **For Admin Users:**
   - [PUBLISHER_TRAFFIC_DASHBOARD_GUIDE.md](./PUBLISHER_TRAFFIC_DASHBOARD_GUIDE.md)

3. **For Publishers:**
   - GA4 verification instructions (from email template above)
   - Monthly traffic reports (auto-generated from admin dashboard)

---

## Contact & Support

**For technical issues:**
- Check Supabase dashboard: https://app.supabase.com
- Review mobile app logs (search: `[OutboundClick]`)
- Check browser console in admin panel

**For publisher questions:**
- Use email templates above
- Reference admin dashboard data
- Provide GA4 verification steps

---

## Final Sign-Off

- [ ] All database migrations applied successfully
- [ ] Mobile app builds without errors
- [ ] Admin panel builds and deploys successfully
- [ ] End-to-end test completed (mobile → database → admin)
- [ ] Documentation reviewed and accessible
- [ ] Team trained on new Publisher Traffic dashboard
- [ ] Ready to onboard publishers

**Deployment Date:** _______________  
**Deployed By:** _______________  
**Verified By:** _______________

🚀 **Ready to distribute traffic to publishers!**
