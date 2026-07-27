using Project.Services;
using WorkerAlias = Project.Services.Worker;
using static Project.Tools.Operations;

namespace App;

class Main
{
    void Launch()
    {
        Local.Start();
        Worker.Start();
        WorkerAlias.Create();
        Run();
        GlobalRun();
        new Worker();
        Missing();
        Console.WriteLine("done");
    }
}
