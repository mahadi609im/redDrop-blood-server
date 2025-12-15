const express = require('express');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 3000;
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const admin = require('firebase-admin');

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString(
  'utf8'
);
const serviceAccount = JSON.parse(decoded);

const stripe = require('stripe')(process.env.STRIPE_SECRET);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// middleware
app.use(cors());
app.use(express.json());

const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ message: 'unauthorized access' });
  }

  try {
    const idToken = token.split(' ')[1];
    const decoded = await admin.auth().verifyIdToken(idToken);

    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: 'unauthorized access' });
  }
};

// redDrop
// KMgAnxqjIgaXYmVm

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.4k43auc.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();
    const redDropDB = client.db('redDrop');
    const donationRequestsCollection = redDropDB.collection('donationRequests');
    const usersCollection = redDropDB.collection('users');
    const fundsCollection = redDropDB.collection('funds');

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await usersCollection.findOne(query);

      if (!user || user.role !== 'admin') {
        return res.status(403).send({ message: 'forbidden access' });
      }

      next();
    };

    const verifyAV = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await usersCollection.findOne(query);

      if (!user || user.role == 'donor') {
        return res.status(403).send({ message: 'forbidden access' });
      }

      next();
    };

    // create checkout session
    app.post('/create-checkout-session', async (req, res) => {
      const { amount, email, displayName } = req.body;

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              unit_amount: Number(amount) * 100,
              product_data: {
                name: 'Blood Donation Fund',
                description: `Donated by ${displayName}`,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: email,
        mode: 'payment',

        metadata: {
          displayName,
          email,
          amount,
        },

        success_url: `${process.env.SITE_DOMAIN}/fund-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/fund-cancelled`,
      });

      res.send({ url: session.url });
    });

    app.post('/funds', async (req, res) => {
      try {
        const { sessionId } = req.body;

        if (!sessionId) {
          return res.status(400).send({ message: 'sessionId required' });
        }

        // 🔐 Verify payment from Stripe
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status !== 'paid') {
          return res.status(400).send({ message: 'Payment not completed' });
        }

        // 🚫 Prevent duplicate save
        const alreadyExists = await fundsCollection.findOne({
          transactionId: session.payment_intent,
        });

        if (alreadyExists) {
          return res.send({ message: 'Fund already recorded' });
        }

        // 💰 Save fund
        const fund = {
          name: session.metadata.displayName,
          email: session.metadata.email,
          amount: session.amount_total / 100,
          transactionId: session.payment_intent,
          fundAt: new Date(),
        };

        await fundsCollection.insertOne(fund);

        res.send({ success: true, fundInfo: fund });
      } catch (error) {
        res.status(500).send({ message: 'Internal server error' });
      }
    });

    // get all funds (table view)
    app.get('/funds', verifyFBToken, async (req, res) => {
      const funds = await fundsCollection.find().sort({ fundAt: -1 }).toArray();

      res.send(funds);
    });

    app.get('/funds/total', async (req, res) => {
      try {
        const totalResult = await fundsCollection.find().toArray();

        const totalAmount = totalResult.reduce(
          (sum, fund) => sum + fund.amount,
          0
        );

        res.send({ totalAmount });
      } catch (error) {
        res.status(500).send({ message: 'Internal server error' });
      }
    });

    app.get('/donors', async (req, res) => {
      const { bloodGroup, district, upazila } = req.query;
      const query = { role: 'donor' };

      if (bloodGroup) query.bloodGroup = bloodGroup;
      if (district) query.district = district;
      if (upazila) query.upazila = upazila;

      const donors = await usersCollection.find(query).toArray();
      res.send(donors);
    });

    app.get('/donationRequests/pending', async (req, res) => {
      try {
        const pendingRequests = await donationRequestsCollection
          .find({ status: 'pending' })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(pendingRequests);
      } catch (err) {
        res.status(500).send({ message: 'Server Error' });
      }
    });

    // 1️⃣ My Donation Requests (Donor)
    app.get('/donationRequests/my', verifyFBToken, async (req, res) => {
      try {
        const email = req.decoded_email; // logged-in user's email
        const query = { requesterEmail: email };

        const cursor = donationRequestsCollection
          .find(query)
          .sort({ createdAt: -1 });
        const myRequests = await cursor.toArray();

        res.send(myRequests);
      } catch (err) {
        res.status(500).send({ message: 'Server Error' });
      }
    });

    // 2️⃣ All Donation Requests (Admin + Volunteer)
    app.get('/donationRequests', verifyFBToken, verifyAV, async (req, res) => {
      try {
        const cursor = donationRequestsCollection
          .find({})
          .sort({ createdAt: -1 });
        const allRequests = await cursor.toArray();

        res.send(allRequests);
      } catch (err) {
        res.status(500).send({ message: 'Server Error' });
      }
    });

    // 3️⃣ Get single donation request by id (any logged-in user)
    app.get('/donationRequests/:id', async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: 'Invalid ID' });
        }

        const query = { _id: new ObjectId(id) };
        const request = await donationRequestsCollection.findOne(query);

        if (!request) return res.status(404).send({ message: 'Not Found' });

        if (request.requesterEmail !== req.decoded_email) {
          const user = await usersCollection.findOne({
            email: req.decoded_email,
          });

          if (user?.role === 'donor') {
            return res.status(403).send({ message: 'Forbidden' });
          }
        }

        res.send(request);
      } catch (err) {
        res.status(500).send({ message: 'Server Error' });
      }
    });

    // PATCH: Edit donation request (only allowed fields)
    app.patch('/donationRequests/:id', verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;
        const updates = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: 'Invalid ID' });
        }

        const request = await donationRequestsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!request)
          return res.status(404).send({ message: 'Request not found' });

        // Check if logged-in user is the requester or admin/volunteer
        if (request.requesterEmail !== req.decoded_email) {
          const user = await usersCollection.findOne({
            email: req.decoded_email,
          });
          if (!user || (user.role !== 'admin' && user.role !== 'volunteer')) {
            return res.status(403).send({ message: 'Forbidden' });
          }
        }

        // Allowed fields to update
        const allowedFields = [
          'recipientName',
          'hospitalName',
          'district',
          'upazila',
          'fullAddress',
          'bloodGroup',
          'donationDate',
          'donationTime',
          'requestMessage',
        ];

        const filteredUpdates = {};
        allowedFields.forEach(field => {
          if (updates[field] !== undefined)
            filteredUpdates[field] = updates[field];
        });

        if (Object.keys(filteredUpdates).length === 0) {
          return res.status(400).send({ message: 'No valid fields to update' });
        }

        const result = await donationRequestsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: filteredUpdates }
        );

        res.send(result);
      } catch (err) {
        res.status(500).send({ message: 'Server Error' });
      }
    });

    app.post('/donationRequests', async (req, res) => {
      const data = req.body;

      const donationRequest = {
        requesterName: data.requesterName,
        requesterEmail: data.requesterEmail,
        recipientName: data.recipientName,
        district: data.district,
        upazila: data.upazila,
        hospitalName: data.hospitalName,
        fullAddress: data.fullAddress,
        bloodGroup: data.bloodGroup,
        donationDate: data.donationDate,
        donationTime: data.donationTime,
        requestMessage: data.requestMessage,

        // server control fields
        status: 'pending', // default
        donorName: '',
        donorEmail: '',
        createdAt: new Date(),
      };

      const result = await donationRequestsCollection.insertOne(
        donationRequest
      );
      res.send(result);
    });

    app.delete('/donationRequests/:id', async (req, res) => {
      const id = req.params.id;

      const query = { _id: new ObjectId(id) };
      const result = await donationRequestsCollection.deleteOne(query);
      res.send(result);
    });

    app.patch('/donationRequests/:id/status', async (req, res) => {
      const id = req.params.id;
      const { status, donor } = req.body;

      const filter = { _id: new ObjectId(id) };

      const update = {
        $set: { status },
      };

      // যদি inprogress হলে donor info add করো
      if (status === 'inprogress' && donor) {
        update.$set.donor = {
          name: donor.name,
          email: donor.email,
        };
      }

      const result = await donationRequestsCollection.updateOne(filter, update);
      res.send(result);
    });

    // Update donation request info
    app.patch('/donationRequests/:id', async (req, res) => {
      const id = req.params.id;
      const updates = req.body;

      const allowedStatuses = ['pending', 'inprogress', 'done', 'canceled'];
      if (updates.status && !allowedStatuses.includes(updates.status)) {
        return res.status(400).send({ message: 'Invalid status value' });
      }

      const filter = { _id: new ObjectId(id) };
      const updateDoc = { $set: updates };

      const result = await donationRequestsCollection.updateOne(
        filter,
        updateDoc
      );
      res.send(result);
    });

    // users collection
    app.get('/users', verifyFBToken, verifyAdmin, async (req, res) => {
      const { email } = req.query;
      const query = {};

      if (email) {
        // if (email !== req.decoded_email) {
        //   return res.status(403).send({ message: 'forbidden access' });
        // }
        query.email = email; // এখানে MongoDB query এ email add করো
      }

      const sortFields = { createdAt: -1 };
      const cursor = usersCollection.find(query).sort(sortFields);
      const allValues = await cursor.toArray();
      res.send(allValues);
    });

    // app.get('/users/:id', async (req, res) => {});

    app.get('/users/:email/role', async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || 'donor' });
    });

    // GET /users/:email/status
    app.get('/users/:email/status', async (req, res) => {
      try {
        const email = req.params.email;
        const query = { email };
        const user = await usersCollection.findOne(query);

        if (!user) {
          return res.status(404).send({ message: 'User not found' });
        }

        res.send({ status: user.status || 'active' }); // default active
      } catch (err) {
        res.status(500).send({ message: 'Server error' });
      }
    });

    app.post('/users', async (req, res) => {
      const user = req.body;

      // Extra fields add
      user.role = 'donor';
      user.status = 'active';
      user.createdAt = new Date();
      user.bloodGroup = req.body.bloodGroup;
      user.district = req.body.district;
      user.upazila = req.body.upazila;

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // PATCH /users/profile → Update user profile using email
    app.patch('/users/profile', verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.decoded_email;

        const { displayName, district, upazila, bloodGroup, photoURL } =
          req.body;

        const updateFields = {};
        if (displayName) updateFields.displayName = displayName;
        if (district) updateFields.district = district;
        if (upazila) updateFields.upazila = upazila;
        if (bloodGroup) updateFields.bloodGroup = bloodGroup;
        if (photoURL) updateFields.photoURL = photoURL;

        const result = await usersCollection.updateOne(
          { email: userEmail },
          { $set: updateFields }
        );

        if (result.modifiedCount === 0) {
          return res
            .status(404)
            .json({ message: 'User not found or unchanged' });
        }

        const updatedUser = await usersCollection.findOne({ email: userEmail });
        res.json(updatedUser);
      } catch (error) {
        res.status(500).json({ message: 'Server error' });
      }
    });

    // PATCH /users/status/:id
    app.patch(
      '/users/status/:id',
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { status } = req.body;

        try {
          const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status } }
          );

          const updatedUser = await usersCollection.findOne({
            _id: new ObjectId(id),
          });
          res.json(updatedUser);
        } catch (err) {
          res.status(500).json({ message: 'Server Error' });
        }
      }
    );

    // PATCH /users/role/:id
    app.patch(
      '/users/:id/role',
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { role } = req.body; // 'admin', 'volunteer', 'donor'
        const { ObjectId } = require('mongodb');

        try {
          const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role } }
          );

          const updatedUser = await usersCollection.findOne({
            _id: new ObjectId(id),
          });
          res.json(updatedUser);
        } catch (err) {
          res.status(500).json({ message: 'Server Error' });
        }
      }
    );

    // Send a ping to confirm a successful connection
    // await client.db('admin').command({ ping: 1 });
    // console.log(
    //   'Pinged your deployment. You successfully connected to MongoDB!'
    // );
  } finally {
    // Ensures that the client will close when you finish/error
    //  await client.close();
  }
}
run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('bismillah');
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
