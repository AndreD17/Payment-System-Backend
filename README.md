
# 💳 SaaS Payment & Subscription Backend API

A production-style backend API implementing subscription billing, payment processing, and webhook-driven state synchronization using Stripe (Test Mode).

This project demonstrates real-world SaaS billing architecture including:

- Secure checkout sessions
- Webhook verification
- Subscription lifecycle management
- Idempotent event handling
- Refund support
- Role-based access control (RBAC)
- Production-ready middleware (rate limiting, helmet, compression)

⚠️ This project uses Stripe Test Mode for safe demonstration.
No real payments are processed.

---

## 🚀 Tech Stack

- Node.js
- Express.js
- TypeScript
- PostgreSQL
- Stripe API
- JWT Authentication
- Zod (Validation)
- Helmet (Security)
- Express Rate Limit
- Compression
- Nodemailer (Email notifications)

---

## 🏗 Architecture Overview

This backend follows a production-grade SaaS billing structure:

1. User authenticates
2. User selects a pricing plan
3. Backend creates Stripe Checkout Session
4. User completes payment via Stripe
5. Stripe sends webhook event
6. Backend verifies signature
7. Subscription status updated in database
8. Access granted based on subscription status

All subscription state is controlled by webhooks (not frontend redirects).

---

## 🔐 Authentication & Authorization

- JWT-based authentication
- Role-based access control (User/Admin)
- Protected routes using middleware
- Ownership checks for subscription operations

---

## 💳 Payments (Stripe Test Mode)

This project uses Stripe Test Mode for safe demonstration.

### Test Card

Use:

Card Number: `4242 4242 4242 4242`  
Expiry: Any future date  
CVC: Any 3 digits  

Declined card:
`4000 0000 0000 0002`

---

## 📦 Subscription Lifecycle Handling

Handled Webhook Events:

- checkout.session.completed
- invoice.payment_succeeded
- invoice.payment_failed
- customer.subscription.updated
- customer.subscription.deleted
- charge.refunded

Each event:
- Is verified using Stripe signature
- Is processed idempotently
- Updates database subscription status accordingly

---

## 🗄 Database Design

Core Tables:

### Users
- id
- email
- password_hash
- role
- stripe_customer_id

### Plans
- id
- name
- stripe_price_id
- interval
- amount_cents
- currency
- active

### Subscriptions
- id
- user_id
- stripe_subscription_id
- status
- current_period_end
- price_id

### Payments
- id
- user_id
- stripe_payment_intent_id
- stripe_invoice_id
- amount
- currency
- status

---

## 🛠 Environment Variables

Create a `.env` file:

```env
PORT=5000

DATABASE_URL=postgresql://username:password@localhost:5432/payments_db

JWT_SECRET=your_jwt_secret

STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

EMAIL_FROM="Billing <billing@yourapp.dev>"
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_USER=
SMTP_PASS=
````

---

## 📡 API Endpoints

### Authentication

POST /api/auth/register
POST /api/auth/login
GET  /api/auth/me

### Plans

GET /api/plans

### Checkout

POST /api/subscription/checkout

### Admin

POST /api/admin/refund

### Webhooks

POST /api/webhooks/stripe

---

## 🔄 Webhook Security

* Stripe signature verified using raw body
* Events stored to prevent duplicate processing
* Idempotency protection implemented
* Invalid signatures rejected

---

## 🧪 Testing Webhooks Locally

Install Stripe CLI:

```
stripe listen --forward-to localhost:5000/api/webhooks/stripe
```

Trigger event:

```
stripe trigger checkout.session.completed
```

---

## 🛡 Security Features

* Helmet (secure headers)
* Rate limiting
* Input validation (Zod)
* JWT expiration
* Secure password hashing
* Role-based route protection

---

## 📈 Production Considerations

In real production:

* Replace test keys with live keys
* Configure HTTPS
* Use secure SMTP provider
* Enable Stripe Radar fraud protection
* Add monitoring/log aggregation

---

## 🎯 Why This Project Matters

This backend demonstrates:

* Real SaaS billing architecture
* Webhook-driven system design
* Event-based state synchronization
* Defensive backend programming
* Clean separation of concerns
* Production-ready middleware setup

---

## 👨‍💻 Author

Damilare Samuel
Backend Software Engineer
Focused on building scalable API systems, secure authentication flows, and subscription-based architectures.

---

## 📄 License

MIT

