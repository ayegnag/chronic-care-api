chronic-care-api/
├── .github/                          # GitHub Actions workflows
│   └── workflows/
│       ├── ci.yml                    # Continuous Integration
│       ├── deploy-dev.yml            # Deploy to development
│       └── deploy-prod.yml           # Deploy to production
├── docs/                             # Documentation
│   ├── api/                          # API documentation
│   │   └── swagger.yml               # OpenAPI specification
│   ├── architecture.md               # Architecture documentation
│   └── deployment.md                 # Deployment guide
├── migrations/                       # Database migrations
│   ├── 001_initial_schema.sql
│   ├── 002_add_indexes.sql
│   └── migrate.js                    # Migration runner
├── scripts/                          # Utility scripts
│   ├── seed-data.js                  # Seed development data
│   ├── setup-dev.sh                  # Development environment setup
│   └── generate-api-key.js           # Generate API keys
├── src/                              # Source code directory
│   ├── handlers/                     # Lambda function handlers
│   │   ├── patient.js
│   │   ├── provider.js
│   │   ├── appointment.js
│   │   ├── medication.js
│   │   ├── notification.js
│   │   └── authorizer.js
│   ├── models/                       # Data models and schemas
│   │   ├── patient.model.js
│   │   ├── provider.model.js
│   │   ├── appointment.model.js
│   │   ├── medication.model.js
│   │   └── notification.model.js
│   ├── services/                     # Business logic services
│   │   ├── patient.service.js
│   │   ├── provider.service.js
│   │   ├── appointment.service.js
│   │   ├── medication.service.js
│   │   └── notification.service.js
│   ├── workers/                      # Background workers
│   │   ├── notificationScheduler.js
│   │   ├── notificationProcessor.js
│   │   └── appointmentReminders.js
│   ├── utils/                        # Utility functions
│   │   ├── database.js               # Database connection and utilities
│   │   ├── cache.js                  # Redis cache utilities
│   │   ├── queue.js                  # RabbitMQ utilities
│   │   ├── fhir.js                   # FHIR conversion utilities
│   │   ├── validator.js              # Input validation
│   │   ├── logger.js                 # Logging utilities
│   │   ├── response.js               # API response formatter
│   │   ├── errors.js                 # Custom error classes
│   │   └── audit.js                  # Audit logging
│   ├── middleware/                   # Express-like middleware
│   │   ├── errorHandler.js
│   │   ├── tenantContext.js
│   │   └── requestValidator.js
│   ├── config/                       # Configuration files
│   │   ├── database.js
│   │   ├── cache.js
│   │   ├── queue.js
│   │   └── aws.js
│   └── constants/                    # Application constants
│       ├── appointmentTypes.js
│       ├── notificationTypes.js
│       └── errorCodes.js
├── layers/                           # Lambda layers
│   └── common/                       # Common layer
│       ├── nodejs/
│       │   ├── node_modules/         # Shared dependencies
│       │   └── utils/                # Shared utilities
│       └── package.json
├── tests/                            # Test suites
│   ├── unit/                         # Unit tests
│   │   ├── services/
│   │   ├── models/
│   │   └── utils/
│   ├── integration/                  # Integration tests
│   │   ├── api/
│   │   └── workers/
│   ├── fixtures/                     # Test data
│   │   ├── patients.json
│   │   └── appointments.json
│   └── setup.js                      # Test environment setup
├── .env.example                      # Environment variables template
├── .eslintrc.js                      # ESLint configuration
├── .gitignore                        # Git ignore rules
├── .prettierrc                       # Prettier configuration
├── jest.config.js                    # Jest testing configuration
├── package.json                      # Node.js dependencies
├── serverless.yml                    # Serverless Framework config
├── README.md                         # Project documentation
└── LICENSE                           # License file