# Publisher Traffic Dashboard - Quick Reference

## Accessing the Dashboard

1. Login to admin panel: `https://your-admin-panel.vercel.app/login`
2. Click "Publisher Traffic" 🚀 in the left sidebar
3. Route: `/publisher-traffic`

---

## Dashboard Overview

### Summary Cards (Top Section)

**📊 Traffic Metrics:**
- **Today:** Total outbound clicks in the last 24 hours
- **This Month:** Total outbound clicks from 1st of current month
- **All Time:** Total outbound clicks since launch

---

## Publisher Table Columns

| Column | Description | Use Case |
|--------|-------------|----------|
| **#** | Ranking by monthly traffic | Identify top performers |
| **Publisher** | Source name | Which publishers get traffic |
| **Website** | Publisher homepage (clickable) | Quick access to publisher site |
| **Today** | Clicks in last 24h | Real-time performance |
| **This Month** | Current month clicks | Monthly reporting |
| **All Time** | Total historical clicks | Lifetime value |
| **Unique Devices** | Distinct device_id count | Audience reach |
| **Last Click** | Most recent click timestamp | Activity monitoring |

---

## Understanding the Data

### What Counts as an Outbound Click?
✅ User taps "Read Full Article" button  
✅ Article opens in Chrome Custom Tab / SFSafariViewController  
✅ URL includes UTM parameters  
✅ Click is logged to `article_outbound_clicks` table

❌ NOT counted:
- Article viewed in-app (that's in App Analytics)
- User scrolls past article
- Article shown in search results

---

## UTM Parameter Information

Every click is tagged with:
```
utm_source=newsera
utm_medium=aggregator
utm_campaign=feed
```

**For User Shares:**
```
utm_source=newsera
utm_medium=share
utm_campaign=user_share
```

---

## How Publishers Track This in GA4

Publishers can verify NewsEra traffic in their Google Analytics 4:

1. Open GA4 → **Acquisition** → **Traffic Acquisition**
2. Look for source: `newsera`
3. Medium will show: `aggregator` or `share`

They can see:
- User count from NewsEra
- Session duration
- Pages per session
- Conversions
- Revenue (if e-commerce enabled)

---

## Common Questions

### Q: Why are some publishers showing 0 clicks today?
**A:** Their articles may not have been clicked in the last 24 hours. This is normal for smaller publishers or slow news days.

### Q: What if I see a publisher with high unique devices but low total clicks?
**A:** This indicates broad reach but low retention. Users are clicking once but not returning for more articles from that publisher.

### Q: Can I see which specific articles drove the traffic?
**A:** Not in this dashboard. You would need to query the `article_outbound_clicks` table directly:
```sql
SELECT 
  a.title,
  COUNT(*) as clicks
FROM article_outbound_clicks aoc
JOIN articles a ON a.id = aoc.article_id
WHERE aoc.source_id = 'publisher-uuid-here'
  AND aoc.clicked_at >= date_trunc('month', now())
GROUP BY a.title
ORDER BY clicks DESC
LIMIT 20;
```

### Q: How do I report traffic to a publisher?
**A:** Use the data from this dashboard:
1. Find the publisher in the table
2. Note their "This Month" value
3. Send them a report: "NewsEra sent you X clicks this month"
4. Include the UTM instructions so they can verify in their GA4

### Q: What's the difference between App Analytics and Publisher Traffic?
**A:** 
- **App Analytics** (`/analytics`) = Internal engagement (users reading in-app)
- **Publisher Traffic** (`/publisher-traffic`) = External clicks (users visiting publisher sites)

---

## Data Refresh

The dashboard pulls from the `publisher_traffic_summary` view, which is calculated on-demand when you load the page.

**Refresh Frequency:** Every page load  
**Lag Time:** <1 second (near real-time)

---

## Export Data (Manual)

To export the current data:

1. Open browser DevTools (F12)
2. Go to Console
3. Run this JavaScript:
```javascript
// Extract table data and copy to clipboard
const rows = [...document.querySelectorAll('tbody tr')].map(row => 
  [...row.querySelectorAll('td')].map(td => td.textContent.trim())
);
console.table(rows);
// Then manually copy from console or implement CSV export
```

---

## Troubleshooting

### Dashboard shows no data
1. Check if any users have clicked "Read Full Article" recently
2. Verify the `article_outbound_clicks` table exists:
   ```sql
   SELECT COUNT(*) FROM article_outbound_clicks;
   ```
3. Check browser console for errors

### Counts seem low
- Remember: only counts clicks to publisher sites, not in-app views
- Check if mobile app is properly calling `openArticleUrl()`
- Verify UTM parameters are being appended

### Publisher not appearing in list
- They may have 0 clicks
- Check if they have a valid `source_id` in the sources table
- Verify their articles are being ingested

---

## Related Documentation

- [PUBLISHER_TRAFFIC_IMPLEMENTATION.md](./PUBLISHER_TRAFFIC_IMPLEMENTATION.md) - Full technical overview
- Migration 063 - Database schema
- `outboundClickService.ts` - Mobile app implementation

---

## Support

For technical issues:
1. Check Supabase logs
2. Check mobile app console logs (search for `[OutboundClick]`)
3. Verify migration 063 ran successfully
