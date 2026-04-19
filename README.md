# Envision Farewell Voting

This app is now prepared for online deployment as a Node.js web service.

## Run locally

1. Copy `.env.example` values into your hosting environment or local shell.
2. Set `MONGODB_URI` to your MongoDB connection string.
3. Run:

```bash
npm install
npm start
```

The app runs on `http://localhost:5000` by default.

## Deploy on Render

1. Push this folder to a GitHub repository.
2. Create a MongoDB database, preferably MongoDB Atlas.
3. In Render, create a new Blueprint or Web Service from the repo.
4. Set these environment variables:

- `MONGODB_URI`
- `DEFAULT_ADMIN_USERNAME`
- `DEFAULT_ADMIN_PASSWORD`
- `NODE_ENV=production`

5. Deploy the service.

Render config is included in [render.yaml](./render.yaml).

## Important

- The old hardcoded MongoDB connection has been removed.
- Change the admin password before using the app publicly.
- For production, use a strong `DEFAULT_ADMIN_PASSWORD`.
