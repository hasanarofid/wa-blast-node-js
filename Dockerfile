# Use a stable Node.js image
FROM node:18-alpine

# Install system dependencies required for native modules and media handling
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    gcc \
    libc-dev \
    ffmpeg \
    libwebp-dev \
    libjpeg-turbo-dev \
    libpng-dev

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the application port (3001 as found in server.js)
EXPOSE 3001

# Command to run the application
CMD ["node", "server.js"]
