# Phone Verification TODOs

This document summarizes all the TODOs added for re-enabling phone verification when an SMS provider becomes available.

## Summary of Changes

Phone verification has been temporarily disabled throughout the application due to the lack of an SMS provider. The following changes have been made with appropriate TODOs for future re-enablement:

## Backend Changes

### 1. OTP Service (`app/services/otp_service.py`)
- **Lines 55, 66**: TODO comments for re-enabling phone check in verification record lookup
- **Lines 67, 69**: TODO comments for re-enabling phone_verified reset
- Phone OTP generation and verification methods are ready but marked with TODOs

### 2. OTP API Endpoints (`app/api/v1/otp.py`)
- **Lines 35, 182**: TODO comments about re-enabling phone validation and verification
- **Lines 222-227**: Phone OTP verification disabled with HTTP 503 response
- **Lines 188-204**: Commented phone OTP generation code ready for re-enablement

### 3. Onboarding API (`app/api/v1/onboarding.py`)
- **Lines around verification check**: TODO comments for re-enabling phone verification requirement
- Phone verification check is commented out in onboarding completion validation

## Frontend Changes

### 4. Verification Step Component (`frontend/src/pages/onboarding/steps/VerificationStep.tsx`)
- **Lines 112-113, 115, 117, 119, 121, 123, 125**: Phone-related state variables commented with TODOs
- **Lines 141-142**: Phone verification status check commented with TODO
- **Lines 154-155, 210**: Phone parameter handling with TODOs
- **Lines 175-201**: Entire `sendPhoneOTP` function commented with TODO
- **Lines 233-262**: Entire `verifyPhoneOTP` function commented with TODO
- **Lines 271-276**: Phone OTP auto-verification useEffect commented with TODO
- **Lines 278, 285**: Phone verification requirements commented with TODOs
- **Lines 385-462**: Entire phone verification UI card commented with TODO
- **Lines 478-483**: Phone verification progress indicator commented with TODO

### 5. Main Onboarding Page (`frontend/src/pages/onboarding/OnboardingPage.tsx`)
- **Line 65**: Verification step description updated with TODO for phone verification
- **Lines 98, 123**: Phone verification data structure fields marked with TODOs

## Configuration Files

### 6. Environment Template (`backend/.env.example`)
- SMS provider configuration template added:
  - `MSG91_API_KEY`
  - `MSG91_SENDER_ID`
  - `TWILIO_ACCOUNT_SID`
  - `TWILIO_AUTH_TOKEN` 
  - `TWILIO_FROM_NUMBER`

## SMS Service Infrastructure

### 7. SMS Service (`app/services/sms_service.py`)
- Complete SMS service implementation ready with MSG91 and Twilio providers
- Service will automatically initialize when environment variables are provided
- No code changes needed - just add the API keys to environment

## Re-enablement Steps

When SMS provider becomes available:

1. **Add SMS provider credentials to environment variables**
2. **Backend**: Uncomment phone verification TODOs in:
   - `app/services/otp_service.py` (verification record checks)
   - `app/api/v1/otp.py` (phone OTP endpoints) 
   - `app/api/v1/onboarding.py` (phone verification requirement)

3. **Frontend**: Uncomment phone verification TODOs in:
   - `VerificationStep.tsx` (phone UI and logic)
   - `OnboardingPage.tsx` (step description and data structure)

4. **Update descriptions**: 
   - Change "Verify Email Address" back to "Verify Contact Details"
   - Update component descriptions accordingly

5. **Test the complete flow**:
   - Email verification (currently working)
   - Phone verification (after re-enabling)
   - Both verifications required for onboarding completion

## Notes

- All SMS infrastructure is already built and ready
- Phone verification UI components are complete but commented out
- Database models and API endpoints support phone verification
- Only environment configuration is needed to activate the feature

The application currently works with email-only verification, and phone verification can be easily re-enabled by following the TODOs when an SMS provider becomes available.