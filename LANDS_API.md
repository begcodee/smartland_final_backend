# Lands API Documentation

## Database Setup

Before using the Lands API, you need to set up the database tables. Run the SQL script:

```bash
psql -U your_username -d your_database -f src/config/schema.sql
```

Or connect to your PostgreSQL database and run the contents of `src/config/schema.sql`.

## API Endpoints

### 1. Create Land (POST /api/lands)

Create a new land record.

**Request Body:**
```json
{
  "land_name": "Green Valley Farm",
  "location": "123 Farm Road, County",
  "size": 5000.50,
  "coordinates": {
    "lat": 40.7128,
    "lng": -74.0060
  },
  "owner_id": 1,
  "land_type": "agricultural",
  "description": "Beautiful farmland with water access"
}
```

**Required Fields:** `land_name`, `location`, `size`, `owner_id`

**Response (201):**
```json
{
  "id": 1,
  "land_name": "Green Valley Farm",
  "location": "123 Farm Road, County",
  "size": 5000.50,
  "coordinates": {
    "lat": 40.7128,
    "lng": -74.0060
  },
  "owner_id": 1,
  "land_type": "agricultural",
  "description": "Beautiful farmland with water access",
  "created_at": "2026-02-18T10:30:00.000Z",
  "updated_at": "2026-02-18T10:30:00.000Z"
}
```

---

### 2. Get All Lands (GET /api/lands)

Retrieve all lands with owner information.

**Response (200):**
```json
[
  {
    "id": 1,
    "land_name": "Green Valley Farm",
    "location": "123 Farm Road, County",
    "size": 5000.50,
    "coordinates": {
      "lat": 40.7128,
      "lng": -74.0060
    },
    "owner_id": 1,
    "land_type": "agricultural",
    "description": "Beautiful farmland with water access",
    "owner_name": "John Doe",
    "owner_email": "john@example.com",
    "created_at": "2026-02-18T10:30:00.000Z",
    "updated_at": "2026-02-18T10:30:00.000Z"
  }
]
```

---

### 3. Get Lands by User (GET /api/lands/user/:userId)

Retrieve all lands owned by a specific user.

**Parameters:**
- `userId` (path parameter) - The ID of the user

**Example:** `GET /api/lands/user/1`

**Response (200):**
```json
[
  {
    "id": 1,
    "land_name": "Green Valley Farm",
    "location": "123 Farm Road, County",
    "size": 5000.50,
    "coordinates": {
      "lat": 40.7128,
      "lng": -74.0060
    },
    "owner_id": 1,
    "land_type": "agricultural",
    "description": "Beautiful farmland with water access",
    "owner_name": "John Doe",
    "owner_email": "john@example.com",
    "created_at": "2026-02-18T10:30:00.000Z",
    "updated_at": "2026-02-18T10:30:00.000Z"
  }
]
```

---

### 4. Transfer Land Ownership (POST /api/lands/:id/transfer)

Transfer ownership of a land from current owner to a new owner.

**Parameters:**
- `id` (path parameter) - The ID of the land to transfer

**Request Body:**
```json
{
  "new_owner_id": 2,
  "transfer_reason": "Sale agreement dated 2026-02-18"
}
```

**Required Fields:** `new_owner_id`

**Response (200):**
```json
{
  "message": "Land ownership transferred successfully",
  "land": {
    "id": 1,
    "land_name": "Green Valley Farm",
    "location": "123 Farm Road, County",
    "size": 5000.50,
    "coordinates": {
      "lat": 40.7128,
      "lng": -74.0060
    },
    "owner_id": 2,
    "land_type": "agricultural",
    "description": "Beautiful farmland with water access",
    "created_at": "2026-02-18T10:30:00.000Z",
    "updated_at": "2026-02-18T11:30:00.000Z"
  },
  "transfer_details": {
    "from": "John Doe",
    "to": "Jane Smith",
    "reason": "Sale agreement dated 2026-02-18"
  }
}
```

## Error Responses

All endpoints may return the following error responses:

**400 Bad Request:**
```json
{
  "error": "Missing required fields: land_name, location, size, owner_id"
}
```

**404 Not Found:**
```json
{
  "error": "Land not found"
}
```

**500 Internal Server Error:**
```json
{
  "error": "Failed to create land"
}
```

## Testing with cURL

### Create a land:
```bash
curl -X POST http://localhost:5000/api/lands \
  -H "Content-Type: application/json" \
  -d '{
    "land_name": "Green Valley Farm",
    "location": "123 Farm Road, County",
    "size": 5000.50,
    "coordinates": {"lat": 40.7128, "lng": -74.0060},
    "owner_id": 1,
    "land_type": "agricultural",
    "description": "Beautiful farmland"
  }'
```

### Get all lands:
```bash
curl http://localhost:5000/api/lands
```

### Get lands by user:
```bash
curl http://localhost:5000/api/lands/user/1
```

### Transfer ownership:
```bash
curl -X POST http://localhost:5000/api/lands/1/transfer \
  -H "Content-Type: application/json" \
  -d '{
    "new_owner_id": 2,
    "transfer_reason": "Sale agreement"
  }'
```

## Database Schema

### lands table:
- `id` - Primary key (auto-increment)
- `land_name` - Name of the land (required)
- `location` - Location address (required)
- `size` - Size in square meters or acres (required)
- `coordinates` - JSON object with lat/lng coordinates
- `owner_id` - Foreign key to users table (required)
- `land_type` - Type of land (residential, commercial, agricultural, etc.)
- `description` - Additional description
- `created_at` - Timestamp of creation
- `updated_at` - Timestamp of last update

### land_transfers table:
- `id` - Primary key (auto-increment)
- `land_id` - Foreign key to lands table
- `from_owner_id` - Foreign key to users table
- `to_owner_id` - Foreign key to users table
- `transfer_reason` - Reason for transfer
- `transfer_date` - Timestamp of transfer
