namespace Fixtures.Outer
{
    using Local = Project.Local;

    namespace Inner
    {
        class Worker
        {
            void Run() { Local.Start(); }
        }
    }
}
