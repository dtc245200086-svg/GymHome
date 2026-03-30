#!/bin/bash
# 🔐 GymHome Scanner - Quick Test Guide
# Navigate to http://localhost:3000/scanner to test

## OPTION 1: Automatic QR Testing via API
# Run these curl commands to simulate QR scans

# Test 1: Valid Member - Should show SUCCESS (✅)
curl -X POST http://localhost:3000/access \
  -H "Content-Type: application/json" \
  -d '{
    "qr_data": "member_001",
    "floor": 2
  }'

# Test 2: Expired Member - Should show EXPIRED (⚠️)
curl -X POST http://localhost:3000/access \
  -H "Content-Type: application/json" \
  -d '{
    "qr_data": "member_expired",
    "floor": 3
  }'

# Test 3: Invalid QR - Should show ERROR (❌)
curl -X POST http://localhost:3000/access \
  -H "Content-Type: application/json" \
  -d '{
    "qr_data": "invalid_qr_code",
    "floor": 1
  }'

# Test 4: No Floor - Should show ERROR
curl -X POST http://localhost:3000/access \
  -H "Content-Type: application/json" \
  -d '{
    "qr_data": "member_001",
    "floor": ""
  }'

## OPTION 2: Manual Testing via Browser

# 1. Open Scanner Page:
#    http://localhost:3000/scanner

# 2. Create a test member:
#    - Go to http://localhost:3000/members
#    - Find "Nguyen Van A" or generate new QR

# 3. Scan QR:
#    - Show QR code to camera
#    - Or use mobile phone camera
#    - System will auto-detect and process

# 4. Watch for:
#    - ✅ Green notification on success
#    - 👤 Member info card appears
#    - 🔊 Audio beep plays
#    - 📍 Floor & timestamp display
#    - ⏰ Auto-clear after 3 seconds

## OPTION 3: Test Dashboard Links

# Home Page Scanner:
http://localhost:3000
# Click: 🔐 Quét Thẻ Vào Cửa

# Admin Dashboard (Login: admin/admin):
http://localhost:3000/admin/dashboard
# Click: 🔐 Quét Thẻ Vào Cửa

# Receptionist Dashboard (Login: letan/letan):
http://localhost:3000/receptionist/dashboard
# Click: 🔐 Quét Thẻ Vào Cửa

## OPTION 4: Test Different Scenarios

# Test with Floor 1 - Yoga
# Test with Floor 2 - Cardio (has most members)
# Test with Floor 3 - PT Training
# Test with Floor 4 - VIP
# Test with Floor 5 - Admin

# Try scanning multiple times quickly:
# - Should prevent duplicate processing
# - Should auto-clear between scans
# - Should maintain responsive UI

## EXPECTED RESULTS

### Scenario 1: Valid, Active Member
Status: ✅ SUCCESS
Message: "✅ Chào mừng [Name]! Truy cập tầng 2"
Sound: Long, rising beep
Card: Shows member details + green
Auto-clear: ✓ After 3 seconds

### Scenario 2: Expired Member
Status: ⚠️ EXPIRED
Message: "⚠️ Thẻ đã hết hạn (Hạn: YYYY-MM-DD)"
Sound: Error tone
Card: Shows member + warning
Auto-clear: ✓

### Scenario 3: Invalid QR
Status: ❌ ERROR
Message: "❌ Mã QR không hợp lệ"
Sound: Error beep
Card: Not shown
Auto-clear: ✓

### Scenario 4: Restricted Member
Status: 🚫 RESTRICTED
Message: "❌ Từ chối truy cập - Yêu cầu..."
Sound: Error beep
Card: Shows member
Auto-clear: ✓

## TROUBLESHOOTING

No notification appearing?
→ Check browser console (F12)
→ Verify floor is selected
→ Ensure QR data is valid

No audio playing?
→ Check speaker volume
→ Try refreshing page
→ Scroll page first (some browsers require user gesture)

Member card not showing?
→ Verify member exists in database
→ Check member expiry date
→ Ensure QR data matches member

Scanner not responsive?
→ Check if "isProcessing" state cleared
→ Try page refresh
→ Check network in DevTools Network tab

## Performance Notes

- Processing time: <100ms
- Notification animation: 300ms
- Auto-clear delay: 3000ms
- Sound duration: 200-300ms
- Member card persistence: 5000ms

## Browser Compatibility

✅ Chrome/Edge: Full support (Web Audio API)
✅ Firefox: Full support
✅ Safari: Full support (v14+)
⚠️ Mobile Safari: Audio may require gesture
✅ Mobile Chrome: Full support including camera

## API Response Format

All responses follow this JSON structure:

```json
{
  "success": boolean,
  "message": "string with emoji",
  "type": "success|expired|restricted|error|invalid",
  "member": {
    "id": number,
    "name": string,
    "phone": string,
    "type": string,
    "expiry": string (YYYY-MM-DD),
    "pt_sessions": number
  },
  "floor": number,
  "timestamp": string (HH:MM:SS)
}
```

---
Last Updated: Phase 7 (2024)
Status: ✅ READY FOR TESTING
