const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// MySQL Connection Pool
const pool = mysql.createPool({
    host: 'gateway01.us-west-2.prod.aws.tidbcloud.com',
    user: '4SEsFDwaUcyLr8a.root',
    password: 'xYUSB6xYzC1sJuXi',
    database: 'parking_system',
    ssl: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
        ca: require('fs').readFileSync('./certs/isrgrootx1.pem')
    },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Add connection check function
async function checkDatabaseConnection() {
    try {
        const connection = await pool.getConnection();
        console.log('✅ MySQL Database connected successfully');

        const [result] = await connection.query('SELECT 1');
        console.log('✅ Database query test successful');

        connection.release();
        return true;
    } catch (error) {
        console.error('❌ Database Connection Failed!');
        console.error('Error details:', error.message);
        return false;
    }
}

// Initialize Database Tables
async function initDB() {
    const isConnected = await checkDatabaseConnection();
    if (!isConnected) {
        console.error('Database initialization skipped due to connection failure');
        return;
    }

    try {
        const connection = await pool.getConnection();
        console.log('Starting table initialization...');

        await connection.query(`
            CREATE TABLE IF NOT EXISTS vehicles (
                id INT AUTO_INCREMENT PRIMARY KEY,
                vehicle VARCHAR(255),
                vehicleType VARCHAR(50),
                spotNumber INT,
                arrivalTime VARCHAR(50),
                departureTime VARCHAR(50),
                fare VARCHAR(50)
            )
        `);
        console.log('✅ Vehicles table ready');

        await connection.query(`
            CREATE TABLE IF NOT EXISTS settings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                maxCapacity INT,
                twoWheelerBaseFare DECIMAL(10,2),
                twoWheelerHourlyRate DECIMAL(10,2),
                fourWheelerBaseFare DECIMAL(10,2),
                fourWheelerHourlyRate DECIMAL(10,2)
            )
        `);
        console.log('✅ Settings table ready');

        const [existingSettings] = await connection.query('SELECT COUNT(*) as count FROM settings');
        if (existingSettings[0].count === 0) {
            await connection.query(`
                INSERT INTO settings (maxCapacity, twoWheelerBaseFare, twoWheelerHourlyRate, fourWheelerBaseFare, fourWheelerHourlyRate)
                VALUES (5, 20, 10, 40, 20)
            `);
            console.log('✅ Default settings inserted');
        }

        console.log('✅ Database initialization complete!');
        connection.release();
    } catch (error) {
        console.error('❌ Database initialization error:', error.message);
        throw error;
    }
}

// Routes

// Get all vehicles (not yet departed)
app.get('/api/vehicles', async (req, res) => {
    try {
        const [vehicles] = await pool.query('SELECT * FROM vehicles WHERE departureTime IS NULL');
        res.json(vehicles);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Add new vehicle
app.post('/api/vehicles', async (req, res) => {
    try {
        const { vehicle, vehicleType, spotNumber, arrivalTime } = req.body;
        const [result] = await pool.query(
            'INSERT INTO vehicles (vehicle, vehicleType, spotNumber, arrivalTime) VALUES (?, ?, ?, ?)',
            [vehicle, vehicleType, spotNumber, arrivalTime]
        );
        const [newVehicle] = await pool.query('SELECT * FROM vehicles WHERE id = ?', [result.insertId]);
        res.status(201).json(newVehicle[0]);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

// Remove vehicle (two-stage process)
app.delete('/api/vehicles/:id', async (req, res) => {
    try {
        const [vehicleResult] = await pool.query('SELECT * FROM vehicles WHERE id = ?', [req.params.id]);
        const vehicle = vehicleResult[0];

        if (!vehicle) {
            return res.status(404).json({ message: 'Vehicle not found' });
        }

        if (vehicle.departureTime) {
            const billData = {
                vehicle: vehicle.vehicle,
                vehicleType: vehicle.vehicleType,
                arrivalTime: vehicle.arrivalTime,
                departureTime: vehicle.departureTime,
                fare: vehicle.fare
            };
            return res.json({
                status: 'ready_for_bill',
                message: 'Vehicle ready for final removal',
                billData
            });
        }

        // First stage: Add departure time and calculate fare
        const departureTime = new Date().toLocaleTimeString();
        const arrivalTimeStr = vehicle.arrivalTime;

        // Dummy duration logic for now
        const duration = 1;

        const [settingsResult] = await pool.query('SELECT * FROM settings LIMIT 1');
        const settings = settingsResult[0];

        const baseFare = vehicle.vehicleType === 'twoWheeler'
            ? Number(settings.twoWheelerBaseFare)
            : Number(settings.fourWheelerBaseFare);
        const hourlyRate = vehicle.vehicleType === 'twoWheeler'
            ? Number(settings.twoWheelerHourlyRate)
            : Number(settings.fourWheelerHourlyRate);

        const totalFare = baseFare + (duration * hourlyRate);
        const fare = `₹${totalFare}`;

        await pool.query('UPDATE vehicles SET departureTime = ?, fare = ? WHERE id = ?', [departureTime, fare, req.params.id]);

        const [updatedVehicle] = await pool.query('SELECT * FROM vehicles WHERE id = ?', [req.params.id]);

        res.json({
            status: 'departure_added',
            message: 'Departure time and fare added',
            vehicle: updatedVehicle[0]
        });
    } catch (error) {
        console.error('Error in remove vehicle:', error);
        res.status(500).json({ message: 'Failed to process vehicle removal', error: error.message });
    }
});

// Final removal of vehicle
app.delete('/api/vehicles/:id/complete', async (req, res) => {
    try {
        const [vehicleResult] = await pool.query('SELECT * FROM vehicles WHERE id = ?', [req.params.id]);
        const vehicle = vehicleResult[0];

        if (!vehicle) {
            return res.status(404).json({ message: 'Vehicle not found' });
        }

        await pool.query('DELETE FROM vehicles WHERE id = ?', [req.params.id]);

        res.json({
            status: 'removed',
            message: 'Vehicle completely removed',
            vehicle
        });
    } catch (error) {
        console.error('Error in final vehicle removal:', error);
        res.status(500).json({ message: 'Failed to complete vehicle removal', error: error.message });
    }
});

// Vehicle history
app.get('/api/vehicles/history', async (req, res) => {
    try {
        const [vehicles] = await pool.query('SELECT * FROM vehicles WHERE departureTime IS NOT NULL AND fare IS NOT NULL');
        res.json(vehicles);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Get settings
app.get('/api/settings', async (req, res) => {
    try {
        const [settingsResult] = await pool.query('SELECT * FROM settings LIMIT 1');
        const settings = settingsResult[0];

        const formattedSettings = {
            maxCapacity: settings.maxCapacity,
            rates: {
                twoWheeler: {
                    baseFare: settings.twoWheelerBaseFare,
                    hourlyRate: settings.twoWheelerHourlyRate
                },
                fourWheeler: {
                    baseFare: settings.fourWheelerBaseFare,
                    hourlyRate: settings.fourWheelerHourlyRate
                }
            }
        };

        res.json(formattedSettings);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Update settings
app.put('/api/settings', async (req, res) => {
    try {
        const { maxCapacity, rates } = req.body;

        await pool.query(`
            UPDATE settings SET
            maxCapacity = ?,
            twoWheelerBaseFare = ?,
            twoWheelerHourlyRate = ?,
            fourWheelerBaseFare = ?,
            fourWheelerHourlyRate = ?
            WHERE id = 1
        `, [
            maxCapacity,
            rates.twoWheeler.baseFare,
            rates.twoWheeler.hourlyRate,
            rates.fourWheeler.baseFare,
            rates.fourWheeler.hourlyRate
        ]);

        const [updated] = await pool.query('SELECT * FROM settings LIMIT 1');
        res.json(updated[0]);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Get all database tables
app.get('/api/db/tables', async (req, res) => {
    try {
        const [tables] = await pool.query('SHOW TABLES');
        res.json(tables);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Get data from a specific table
app.get('/api/db/table/:tableName', async (req, res) => {
    try {
        const tableName = req.params.tableName;
        const validTables = ['vehicles', 'settings'];

        if (!validTables.includes(tableName)) {
            return res.status(400).json({ message: 'Invalid table name' });
        }

        const [rows] = await pool.query(`SELECT * FROM ${tableName}`);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server is running on port ${PORT}`);
    try {
        await initDB();
        console.log('🚀 Server is ready to accept requests');
    } catch (error) {
        console.error('Failed to initialize database. Server may not work properly.');
    }
});
