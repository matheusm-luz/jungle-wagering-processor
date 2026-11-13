-- Runs once, when the data volume is first initialised.
-- The integration and concurrency suites use their own database, so they never touch the
-- data of a running `app` service.
CREATE DATABASE wagering_test OWNER wagering;
