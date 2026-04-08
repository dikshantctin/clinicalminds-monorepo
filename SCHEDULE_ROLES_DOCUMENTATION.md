# Role-Based Schedule Functionality Documentation

## Overview

The Daily Calendar component has been enhanced to provide role-contextual scheduling functionality that adapts to different user roles within the ClinicalMind system. This implementation ensures that users see appropriate schedule information based on their permissions and responsibilities.

## User Roles and Schedule Access

### 1. **Admin** 
- **View Scope**: All sessions across the organization
- **Title**: "Organization Schedule"
- **Description**: "View all scheduled sessions across the organization"
- **Permissions**: 
  - `view_schedule` - View daily and weekly schedules
  - `view_all_schedules` - View all team schedules
  - `create_schedule` - Create and schedule sessions
  - `edit_schedule` - Edit scheduled sessions
  - `manage_schedule` - Manage all schedules and availability
- **Features**:
  - Can see all therapists' schedules
  - Shows therapist names for each session
  - Full organizational oversight
  - Badge: "All Sessions" (purple)

### 2. **Clinical Director**
- **View Scope**: All sessions across the clinical team
- **Title**: "Clinical Team Schedule"
- **Description**: "Monitor clinical team schedules and patient sessions"
- **Permissions**: Same as Admin for schedule management
- **Features**:
  - Can see all clinical staff schedules
  - Shows therapist names for each session
  - Clinical oversight capabilities
  - Badge: "All Sessions" (purple)

### 3. **Psychologist**
- **View Scope**: Personal schedule only
- **Title**: "My Schedule"
- **Description**: "Your scheduled sessions and patient appointments"
- **Permissions**:
  - `view_schedule` - View daily and weekly schedules
  - `create_schedule` - Create and schedule sessions
  - `edit_schedule` - Edit scheduled sessions
- **Features**:
  - Sees only their own sessions
  - Can manage their personal schedule
  - Badge: "My Sessions" (blue)

### 4. **Therapist**
- **View Scope**: Personal schedule only
- **Title**: "My Schedule"
- **Description**: "Your scheduled sessions and patient appointments"
- **Permissions**: Same as Psychologist
- **Features**:
  - Sees only their own sessions
  - Can manage their personal schedule
  - Badge: "My Sessions" (blue)

### 5. **Intern**
- **View Scope**: Personal schedule only
- **Title**: "My Learning Schedule"
- **Description**: "Your supervised sessions and learning opportunities"
- **Permissions**:
  - `view_schedule` - View daily and weekly schedules (read-only)
- **Features**:
  - Sees only their own sessions
  - Read-only access for learning purposes
  - Badge: "My Sessions" (blue)

### 6. **Support Staff**
- **View Scope**: Personal schedule only
- **Title**: "Today's Schedule"
- **Description**: "Click on any time slot to view sessions"
- **Permissions**:
  - `view_schedule` - View daily and weekly schedules (read-only)
- **Features**:
  - Limited access for administrative support
  - Badge: "My Sessions" (blue)

## Technical Implementation

### Backend API Integration

The component now connects to the real backend API (`/api/v1/schedules/daily`) which:

1. **Role-based Filtering**: Automatically filters sessions based on user role
2. **Permission Checking**: Validates user permissions before returning data
3. **Tenant Isolation**: Ensures users only see data from their organization
4. **Real-time Data**: Fetches actual session data from the database

### Frontend Enhancements

1. **Dynamic UI**: Title, description, and badges change based on user role
2. **Permission-based Access**: Uses the permissions system to determine view scope
3. **Loading States**: Shows loading indicators while fetching data
4. **Error Handling**: Graceful fallback to mock data if API fails
5. **Role Indicators**: Visual badges showing "All Sessions" vs "My Sessions"

### API Endpoints Used

- `GET /api/v1/schedules/daily` - Get daily schedule with role-based filtering
- `GET /api/v1/schedules/weekly` - Get weekly schedule
- `GET /api/v1/schedules/stats` - Get schedule statistics
- `GET /api/v1/schedules/availability` - Check therapist availability

## Permission System

### New Schedule Permissions Added

1. **`view_schedule`** - Basic schedule viewing (all roles)
2. **`view_all_schedules`** - View all team schedules (admin/director only)
3. **`create_schedule`** - Create new sessions (admin/director/psychologist/therapist)
4. **`edit_schedule`** - Edit existing sessions (admin/director/psychologist/therapist)
5. **`manage_schedule`** - Full schedule management (admin/director only)

### Permission Matrix

| Role | view_schedule | view_all_schedules | create_schedule | edit_schedule | manage_schedule |
|------|---------------|-------------------|-----------------|---------------|-----------------|
| Admin | ✅ | ✅ | ✅ | ✅ | ✅ |
| Clinical Director | ✅ | ✅ | ✅ | ✅ | ✅ |
| Psychologist | ✅ | ❌ | ✅ | ✅ | ❌ |
| Therapist | ✅ | ❌ | ✅ | ✅ | ❌ |
| Intern | ✅ | ❌ | ❌ | ❌ | ❌ |
| Support Staff | ✅ | ❌ | ❌ | ❌ | ❌ |

## UI/UX Features

### Visual Indicators

1. **Role-based Badges**:
   - Purple badge with users icon for "All Sessions" (admin/director)
   - Blue badge with user icon for "My Sessions" (others)

2. **Dynamic Titles**: Changes based on user role and responsibilities

3. **Contextual Descriptions**: Explains what the user is viewing

4. **Therapist Information**: Shows therapist names for admin/director views

### Responsive Design

- Works on desktop and mobile devices
- Grid layout adapts to screen size
- Touch-friendly interface for mobile users

## Security Considerations

1. **Backend Validation**: All role checks happen on the backend
2. **Permission Enforcement**: Frontend permissions are validated against backend
3. **Tenant Isolation**: Users can only see data from their organization
4. **Audit Logging**: All schedule access is logged for compliance

## Future Enhancements

1. **Schedule Creation**: Add ability to create new sessions
2. **Schedule Editing**: Allow editing of existing sessions
3. **Availability Management**: Manage therapist availability
4. **Conflict Detection**: Warn about scheduling conflicts
5. **Recurring Sessions**: Support for recurring appointments
6. **Calendar Integration**: Export to external calendars
7. **Notifications**: Real-time schedule updates and reminders

## Testing Scenarios

### Admin User
- Should see all sessions across the organization
- Should see therapist names for each session
- Should have "All Sessions" badge
- Should see "Organization Schedule" title

### Clinical Director
- Should see all clinical team sessions
- Should see therapist names for each session
- Should have "All Sessions" badge
- Should see "Clinical Team Schedule" title

### Therapist/Psychologist
- Should see only their own sessions
- Should not see therapist names (shows "You")
- Should have "My Sessions" badge
- Should see "My Schedule" title

### Intern/Support Staff
- Should see only their own sessions (if any)
- Should have limited access
- Should have "My Sessions" badge
- Should see appropriate title based on role

## Error Handling

1. **API Failures**: Graceful fallback to mock data
2. **Permission Denied**: Clear error messages
3. **Network Issues**: Loading states and retry mechanisms
4. **Invalid Data**: Validation and error boundaries

This implementation provides a robust, secure, and user-friendly schedule management system that adapts to the specific needs and permissions of each user role within the ClinicalMind platform.
