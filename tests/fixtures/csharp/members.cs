class Service
{
    private readonly Client client = Client.Create();
    private int first = LoadFirst(), second = LoadSecond();

    public event EventHandler? Changed, Completed;

    public event EventHandler Custom
    {
        add { Register(value); }
        remove { Unregister(value); }
    }

    public string Name { get; init; }

    public int this[int index]
    {
        get { return Load(index); }
        set { Save(index, value); }
    }

    public Service() : this(Build()) { }

    public Service(Client client) : base(client)
    {
        this.client = client;
    }

    ~Service() { Cleanup(); }

    public static Service operator +(Service left, Service right) => Merge(left, right);

    public static explicit operator int(Service value) => Convert(value);
}
